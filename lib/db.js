import pg from 'pg';
import {AppError,normalize,validateEdit,random,offerKeys} from './core.js';
let pool;
export function connection(env=process.env){if(!env.DATABASE_URL)throw new AppError('Conecte um banco PostgreSQL e configure DATABASE_URL na Vercel.',503);return pool??=new pg.Pool({connectionString:env.DATABASE_URL,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:10000});}
export const schema=`
CREATE TABLE IF NOT EXISTS pc_offers(id text PRIMARY KEY,data jsonb NOT NULL,state text NOT NULL DEFAULT 'pendente',version integer NOT NULL DEFAULT 1,updated timestamptz NOT NULL DEFAULT now(),message_id bigint,error text,attempt text,claimed_at timestamptz);
CREATE TABLE IF NOT EXISTS pc_sessions(id text PRIMARY KEY,csrf text NOT NULL,expires timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS pc_tokens(id text PRIMARY KEY,value text NOT NULL);
CREATE TABLE IF NOT EXISTS pc_oauth(state text PRIMARY KEY,session_id text NOT NULL,verifier text NOT NULL,expires timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS pc_rate(id text PRIMARY KEY,count integer NOT NULL DEFAULT 0,expires timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS pc_locks(id text PRIMARY KEY,owner text NOT NULL,expires timestamptz NOT NULL);
`;
export class Repository{
 constructor(db){this.db=db;}
 async init(){await this.db.query(schema);}
 async tx(fn){const c=await this.db.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async list(){const r=await this.db.query('SELECT * FROM pc_offers ORDER BY updated DESC,id DESC');return r.rows.map(row=>({...row.data,id:row.id,estado:row.state,publicado:row.state==='publicado',version:row.version,erro:row.error,message_id:row.message_id,publicado_em:row.state==='publicado'&&row.message_id?row.updated:null}));}
 async page({filter='todas',page='1'}={}){
  if(!['todas','pendente','aprovado','publicado','enviando','incerto','erro','descartado'].includes(filter)||!/^\d{1,8}$/.test(String(page))||Number(page)<1)throw new AppError('Filtro ou página inválidos.');
  const countsResult=await this.db.query('SELECT state,count(*)::int AS total FROM pc_offers GROUP BY state');
  const counts=Object.fromEntries(countsResult.rows.map(r=>[r.state,Number(r.total)]));
  const total=filter==='todas'?Object.entries(counts).reduce((n,[state,count])=>n+(state==='descartado'?0:count),0):(counts[filter]||0);
  const pages=Math.max(1,Math.ceil(total/20)),current=Math.min(Number(page),pages);
  const where=filter==='todas'?"state<>'descartado'":"state=$1";
  const params=filter==='todas'?[20,(current-1)*20]:[filter,20,(current-1)*20];
  const r=await this.db.query(`SELECT * FROM pc_offers WHERE ${where} ORDER BY updated DESC,id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  return {offers:r.rows.map(row=>({...row.data,id:row.id,estado:row.state,version:row.version,erro:row.error,message_id:row.message_id,publicado_em:row.state==='publicado'&&row.message_id?row.updated:null})),counts,total,page:current,pages};
 }
 async offerWriteLock(c){
  await c.query("INSERT INTO pc_locks(id,owner,expires) VALUES('offer-write','transaction',now()) ON CONFLICT DO NOTHING");
  await c.query("SELECT id FROM pc_locks WHERE id='offer-write' FOR UPDATE");
 }
 async add(offers,legacy=false){
  if(!Array.isArray(offers)||offers.length>5000)throw new AppError('Lista de ofertas inválida ou acima de 5000 registros.');
  return this.tx(async c=>{
   await this.offerWriteLock(c);
   const {rows:existing}=await c.query('SELECT id,data,state FROM pc_offers');
   const byKey=new Map();const remember=row=>{for(const key of offerKeys(row.data)){if(!byKey.has(key))byKey.set(key,[]);byKey.get(key).push(row);}};
   existing.forEach(remember);let total=0;
   for(const raw of offers){
    const o=normalize(raw),state=legacy&&raw.publicado===true?'publicado':'pendente';
    const matches=[...new Set(offerKeys(o).flatMap(key=>byKey.get(key)||[]))];
    if(matches.length){
     if(state==='publicado')for(const row of matches){
      if(['enviando','incerto'].includes(row.state))throw new AppError('Há envio em conferência para uma oferta importada. Confira o canal antes de importar.',409);
      if(row.state!=='publicado'){await c.query("UPDATE pc_offers SET state='publicado',version=version+1,updated=now(),error=NULL WHERE id=$1",[row.id]);row.state='publicado';}
     }
     continue;
    }
    const r=await c.query('INSERT INTO pc_offers(id,data,state) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[o.id,JSON.stringify(o),state]);
    total+=r.rowCount;if(r.rowCount)remember({id:o.id,data:o,state});
   }
   return total;
  });
 }
 async edit(body){if(typeof body.id!=='string'||!Number.isInteger(body.version))throw new AppError('ID e versão obrigatórios.');return this.tx(async c=>{await this.offerWriteLock(c);const {rows:[row]}=await c.query('SELECT * FROM pc_offers WHERE id=$1 FOR UPDATE',[body.id]);if(!row)throw new AppError('Oferta não encontrada.',404);if(row.version!==body.version)throw new AppError('Oferta alterada em outra janela. Atualize a lista.',409);const o=validateEdit({...row.data,estado:row.state},body);await c.query('UPDATE pc_offers SET data=$2,state=$3,version=version+1,updated=now(),error=NULL WHERE id=$1',[body.id,JSON.stringify(normalize(o)),o.estado]);});}
 async claim(target){
  if(target&&(typeof target.id!=='string'||!Number.isInteger(target.version)||target.version<1))throw new AppError('Selecione uma oferta e atualize a lista antes de publicar.',400);
  return this.tx(async c=>{
   await this.offerWriteLock(c);
   const {rows:[row]}=target?await c.query('SELECT * FROM pc_offers WHERE id=$1 FOR UPDATE',[target.id]):await c.query("SELECT * FROM pc_offers WHERE state='aprovado' ORDER BY updated,id LIMIT 1 FOR UPDATE SKIP LOCKED");
   if(target&&(!row||row.state!=='aprovado'||row.version!==target.version))throw new AppError('A oferta mudou ou não está aprovada. Atualize a lista e confira novamente.',409);
   if(!row)return null;
   const keys=new Set(offerKeys(row.data));
   const {rows:sent}=await c.query("SELECT id,data FROM pc_offers WHERE id<>$1 AND state IN ('publicado','enviando','incerto')",[row.id]);
   if(sent.some(other=>offerKeys(other.data).some(key=>keys.has(key))))throw new AppError('Este anúncio já possui uma publicação ou envio em conferência. Confira o histórico antes de enviar.',409);
   const attempt=random();await c.query("UPDATE pc_offers SET state='enviando',attempt=$2,claimed_at=now(),version=version+1,updated=now() WHERE id=$1",[row.id,attempt]);
   return {...row.data,id:row.id,attempt};
  });
 }
 async finish(o,result){await this.db.query("UPDATE pc_offers SET state=$3,message_id=$4,error=$5,version=version+1,updated=now() WHERE id=$1 AND attempt=$2 AND state='enviando'",[o.id,o.attempt,result.estado,result.message_id||null,result.erro||null]);}
 async reconcile(body){if(typeof body.publicado!=='boolean'||body.conferido_no_canal!==true)throw new AppError('Confirme a conferência no canal.');const r=await this.db.query("UPDATE pc_offers SET state=$2,error=NULL,attempt=NULL,version=version+1,updated=now() WHERE id=$1 AND state IN ('incerto','enviando') AND claimed_at < now()-interval '5 minutes'",[body.id,body.publicado?'publicado':'pendente']);if(!r.rowCount)throw new AppError('Aguarde 5 minutos após a tentativa e confira o canal antes de liberar.',409);}
 async rate(key,limit=10){const {rows:[r]}=await this.db.query("INSERT INTO pc_rate(id,count,expires) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(id) DO UPDATE SET count=CASE WHEN pc_rate.expires<now() THEN 1 ELSE pc_rate.count+1 END,expires=CASE WHEN pc_rate.expires<now() THEN now()+interval '15 minutes' ELSE pc_rate.expires END RETURNING count",[key]);if(r.count>limit)throw new AppError('Muitas tentativas. Aguarde 15 minutos.',429);}
 async lock(name,fn){const owner=random();const r=await this.db.query("INSERT INTO pc_locks(id,owner,expires) VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT(id) DO UPDATE SET owner=EXCLUDED.owner,expires=EXCLUDED.expires WHERE pc_locks.expires<now() RETURNING owner",[name,owner]);if(!r.rowCount)throw new AppError('Operação já em andamento. Aguarde.',409);try{return await fn();}finally{await this.db.query('DELETE FROM pc_locks WHERE id=$1 AND owner=$2',[name,owner]);}}
}
