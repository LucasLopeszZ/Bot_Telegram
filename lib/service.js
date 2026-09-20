import {load} from 'cheerio';
import {createHash} from 'node:crypto';
import {AppError,hash,random,equal,encrypt,decrypt,telegram} from './core.js';
import {Meli} from './meli.js';
export function createService(repo,env=process.env,fetcher=fetch){
 const meli=new Meli(repo,env,fetcher);
 function configured(){if(!env.APP_URL||new URL(env.APP_URL).protocol!=='https:'||!env.ADMIN_PASSWORD||env.ADMIN_PASSWORD.length<16||!/^[a-f\d]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY||''))throw new AppError('Configure APP_URL, ADMIN_PASSWORD e TOKEN_ENCRYPTION_KEY no servidor.',503);}
 const origin=()=>new URL(env.APP_URL).origin;
 const cookie=(value,max)=>`pc_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${max}`;
 async function session(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pc_session='))?.slice(11);if(!token)return null;const {rows:[row]}=await repo.db.query('SELECT * FROM pc_sessions WHERE id=$1 AND expires>now()',[hash(env.ADMIN_PASSWORD+"\0"+token)]);return row||null;}
 function sameOrigin(req){if(req.headers.origin!==origin())throw new AppError('Origem não autorizada.',403);}
 async function run(req){configured();await repo.init();const op=String(req.query?.op||'session'),method=req.method;const body=req.body||{};
 if(!['GET','POST'].includes(method))throw new AppError('Método não permitido.',405);
 if(method==='POST'&&(!req.headers['content-type']?.startsWith('application/json')||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>50000))throw new AppError('Envie um objeto JSON de até 50 KB.',400);
 if(op==='login'){
  if(method!=='POST')throw new AppError('Use POST.',405);sameOrigin(req);await repo.rate('login-global',60);await repo.rate('login:'+hash(req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||'unknown'),10);
  if(typeof body.password!=='string'||!equal(body.password,env.ADMIN_PASSWORD))throw new AppError('Senha incorreta.',401);
  const token=random(),csrf=random();await repo.db.query("DELETE FROM pc_sessions WHERE expires<now()");await repo.db.query("INSERT INTO pc_sessions(id,csrf,expires) VALUES($1,$2,now()+interval '8 hours')",[hash(env.ADMIN_PASSWORD+"\0"+token),csrf]);return {data:{autenticado:true,csrf},cookie:cookie(token,28800)};
 }
 if(op==='cron'){
  if(method!=='GET'||!env.CRON_SECRET||env.CRON_SECRET.length<32||!equal(req.headers.authorization||'','Bearer '+env.CRON_SECRET))throw new AppError('Não autorizado.',401);return {data:await publish()};
 }
 const s=await session(req);
 if(op==='session'&&method==='GET')return {data:{autenticado:!!s,...(s?{csrf:s.csrf,publicacao_habilitada:env.ENABLE_PUBLISH==='true'}:{})}};
 if(!s)throw new AppError('Entre novamente no painel.',401);
 if(method==='POST'){sameOrigin(req);if(!equal(req.headers['x-csrf-token']||'',s.csrf))throw new AppError('Sessão inválida. Atualize a página.',403);}
 if(op==='offers'&&method==='GET')return {data:await repo.list()};
 if(op==='meli-callback'&&method==='GET'){
  if(typeof req.query.state!=='string'||typeof req.query.code!=='string')throw new AppError('Autorização não concluída. Volte ao painel e tente novamente.');
  const {rows:[pending]}=await repo.db.query('DELETE FROM pc_oauth WHERE state=$1 AND session_id=$2 AND expires>now() RETURNING verifier',[hash(req.query.state),s.id]);if(!pending)throw new AppError('Autorização expirada ou inválida.');
  const fields={grant_type:'authorization_code',code:req.query.code,redirect_uri:env.MELI_REDIRECT_URI};if(env.MELI_PKCE!=='false')fields.code_verifier=decrypt(pending.verifier,env.TOKEN_ENCRYPTION_KEY);
  await repo.lock('meli-oauth',()=>meli.exchange(fields));return {redirect:origin()+'/?meli=conectado'};
 }
 if(method!=='POST')throw new AppError('Operação não encontrada.',404);
 if(op==='logout'){await repo.db.query('DELETE FROM pc_sessions WHERE id=$1',[s.id]);return {data:{ok:true},cookie:cookie('',0)};}
 if(op==='edit'){await repo.edit(body);return {data:{ok:true}};}
 if(op==='create'){await repo.rate('create:'+s.id,30);return {data:{adicionadas:await repo.add([{...body,fonte:'manual',external_id:null}])}};}
 if(op==='reconcile'){await repo.reconcile(body);return {data:{ok:true}};}
 if(op==='publish')return {data:await publish()};
 if(op==='meli-auth'){
  if(!env.MELI_CLIENT_ID||!env.MELI_CLIENT_SECRET||env.MELI_REDIRECT_URI!==origin()+'/api/meli-callback')throw new AppError('Configure o aplicativo ML e a URL de retorno /api/meli-callback neste domínio.',503);
  const state=random(),verifier=random(),params={response_type:'code',client_id:env.MELI_CLIENT_ID,redirect_uri:env.MELI_REDIRECT_URI,state};if(env.MELI_PKCE!=='false'){params.code_challenge=createHash('sha256').update(verifier).digest('base64url');params.code_challenge_method='S256';}
  await repo.db.query('DELETE FROM pc_oauth WHERE expires<now() OR session_id=$1',[s.id]);await repo.db.query("INSERT INTO pc_oauth(state,session_id,verifier,expires) VALUES($1,$2,$3,now()+interval '10 minutes')",[hash(state),s.id,encrypt(verifier,env.TOKEN_ENCRYPTION_KEY)]);return {data:{url:'https://auth.mercadolivre.com.br/authorization?'+new URLSearchParams(params)}};
 }
 if(op==='collect'){
  await repo.rate('collect:'+s.id,10);return {data:await repo.lock('collect',async()=>{const offers=body.fonte==='mercado_livre'?await meli.collect(body.busca):body.fonte==='promobit'?await promobit(fetcher):null;if(!offers)throw new AppError('Fonte inválida.');return {adicionadas:await repo.add(offers),encontradas:offers.length};})};
 }
 if(op==='import'){
  if(!env.JSONBIN_MASTER_KEY||! /^[a-z\d]+$/i.test(env.JSONBIN_BIN_ID||''))throw new AppError('Configure a nova chave e ID do JSONBin no servidor.',503);
  return {data:await repo.lock('import',async()=>{const r=await fetcher(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}/latest`,{headers:{'X-Master-Key':env.JSONBIN_MASTER_KEY},signal:AbortSignal.timeout(12000)});if(!r.ok)throw new AppError('Não foi possível importar a fila antiga.',502);const d=await r.json();return {adicionadas:await repo.add(d.record?.ofertas,true)};})};
 }
 throw new AppError('Operação não encontrada.',404);
 }
 async function publish(){if(env.VERCEL_ENV&&env.VERCEL_ENV!=='production')throw new AppError('Envio bloqueado em prévias. Use o ambiente de produção configurado.',409);if(env.ENABLE_PUBLISH!=='true'||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)throw new AppError('Publicação desabilitada. Configure o canal e ENABLE_PUBLISH no servidor.',409);return repo.lock('publish',async()=>{const o=await repo.claim();if(!o)return {processadas:0};let result;try{result=await telegram(o,env,fetcher);}catch(e){result={estado:'erro',erro:'Revise título e link antes de aprovar novamente.'};}await repo.finish(o,result);return {processadas:1,estado:result.estado};});}
 return {run};
}
export async function promobit(fetcher=fetch){const r=await fetcher('https://www.promobit.com.br/',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new AppError(`Promobit indisponível (HTTP ${r.status}).`,502);const $=load(await r.text());let parsed=0;const offers=[];$('a[href*="/oferta/"]').each((_,a)=>{const card=$(a),title=card.find('span[class*="line-clamp"]').first().text().trim(),spans=card.find('span').toArray();const i=spans.findIndex(s=>$(s).text().trim()==='R$'&&!$(s).hasClass('line-through'));const price=i>=0?$(spans[i+1]).text().trim():'';if(!title||!price)return;parsed++;if(!/t[eê]nis|corrida|whey|creatina|fitness|academia|nike|adidas|asics|garmin|mizuno|olympikus/i.test(title))return;offers.push({titulo:title,preco:'R$ '+price,loja:'Confira na oferta',link_original:new URL(card.attr('href'),'https://www.promobit.com.br').href,fonte:'promobit'});});if(!parsed)throw new AppError('Promobit mudou o HTML; revise o coletor.',502);return offers;}
