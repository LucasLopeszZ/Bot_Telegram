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
 if(op==='cron'||op==='collect-cron'){
  if(method!=='GET'||!env.CRON_SECRET||env.CRON_SECRET.length<32||!equal(req.headers.authorization||'','Bearer '+env.CRON_SECRET))throw new AppError('Não autorizado.',401);if(env.VERCEL_ENV&&env.VERCEL_ENV!=='production')throw new AppError('Rotina bloqueada em prévias.',409);return {data:op==='collect-cron'?await collectPromobit():await publish()};
 }
 const s=await session(req);
 if(op==='session'&&method==='GET')return {data:{autenticado:!!s,...(s?{csrf:s.csrf,publicacao_habilitada:env.ENABLE_PUBLISH==='true',coleta_diaria:!!env.CRON_SECRET&&env.CRON_SECRET.length>=32}:{})}};
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
  await repo.rate('collect:'+s.id,10);if(body.fonte==='promobit')return {data:await collectPromobit()};return {data:await repo.lock('collect',async()=>{const offers=body.fonte==='mercado_livre'?await meli.collect(body.busca):body.fonte==='promobit'?await promobit(fetcher):null;if(!offers)throw new AppError('Fonte inválida.');return {adicionadas:await repo.add(offers),encontradas:offers.length};})};
 }
 if(op==='import'){
  if(!env.JSONBIN_MASTER_KEY||! /^[a-z\d]+$/i.test(env.JSONBIN_BIN_ID||''))throw new AppError('Configure a nova chave e ID do JSONBin no servidor.',503);
  return {data:await repo.lock('import',async()=>{const r=await fetcher(`https://api.jsonbin.io/v3/b/${env.JSONBIN_BIN_ID}/latest`,{headers:{'X-Master-Key':env.JSONBIN_MASTER_KEY},signal:AbortSignal.timeout(12000)});if(!r.ok)throw new AppError('Não foi possível importar a fila antiga.',502);const d=await r.json();return {adicionadas:await repo.add(d.record?.ofertas,true)};})};
 }
 throw new AppError('Operação não encontrada.',404);
 }
 async function collectPromobit(){return repo.lock('collect',async()=>{const offers=await promobit(fetcher);return {adicionadas:await repo.add(offers),encontradas:offers.length};});}
 async function publish(){if(env.VERCEL_ENV&&env.VERCEL_ENV!=='production')throw new AppError('Envio bloqueado em prévias. Use o ambiente de produção configurado.',409);if(env.ENABLE_PUBLISH!=='true'||!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)throw new AppError('Publicação desabilitada. Configure o canal e ENABLE_PUBLISH no servidor.',409);return repo.lock('publish',async()=>{const o=await repo.claim();if(!o)return {processadas:0};let result;try{if(o.fonte==='promobit'){try{const fresh=await promobitDetail(o.link_original,fetcher);if(priceValue(o.preco)!==priceValue(fresh.preco))throw new AppError('O preço informado no Promobit mudou.');}catch{result={estado:'pendente',erro:'Não foi possível confirmar o mesmo preço e disponibilidade no Promobit. Confira a loja e atualize a oferta antes de aprovar novamente.'};}}if(!result)result=await telegram(o,env,fetcher);}catch(e){result={estado:'erro',erro:'Revise título e link antes de aprovar novamente.'};}await repo.finish(o,result);return {processadas:1,estado:result.estado};});}
 return {run};
}

const PROMOBIT='https://www.promobit.com.br';
const FITNESS=/t[eê]nis|corrida|whey|creatina|fitness|academia|nike|adidas|asics|garmin|mizuno|olympikus/i;
const brl=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
function clean(v){return load(String(v||''))('body').text().replace(/\s+/g,' ').trim();}
export function priceValue(v){const match=String(v||'').match(/R\$\s*([\d.]+,\d{2})/);return match?Math.round(Number(match[1].replace(/\./g,'').replace(',','.'))*100):null;}
function offerUrl(value){try{const u=new URL(value,PROMOBIT);if(u.origin!==PROMOBIT||u.username||u.password||!/^\/oferta\/[a-z0-9-]+\/?$/i.test(u.pathname))return null;u.search='';u.hash='';return u.href;}catch{return null;}}
function photoUrl(value){const v=Array.isArray(value)?value[0]:value?.url||value;try{const u=new URL(v);return u.protocol==='https:'&&u.hostname==='i.promobit.com.br'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
function products($){const result=[];function walk(o){if(!o||typeof o!=='object')return;if(Array.isArray(o)){o.forEach(walk);return;}if([].concat(o['@type']||[]).includes('Product')){result.push(o);return;}for(const k of ['@graph','itemListElement','item','mainEntity'])walk(o[k]);}for(const el of $('script[type="application/ld+json"]').toArray()){try{walk(JSON.parse($(el).text()));}catch{}}return result;}
function productOffer(product){const outer=Array.isArray(product.offers)?product.offers[0]:product.offers;const offer=Array.isArray(outer?.offers)?outer.offers[0]:outer?.offers||outer;if(!offer)return null;const availability=String(offer.availability||outer.availability||'');if(!/(?:\/|^)(InStock|LimitedAvailability)$/.test(availability))return null;const value=Number(offer.price??outer.price??outer.lowPrice);if(!Number.isFinite(value)||value<=0||(offer.priceCurrency||outer.priceCurrency)!=='BRL')return null;return {offer,value};}
async function page(url,fetcher,timeout=6000){const r=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(timeout)});if(!r.ok)throw new AppError(`Promobit indisponível (HTTP ${r.status}).`,502);const html=await r.text();if(html.length>2500000)throw new AppError('Página do Promobit acima do limite.',502);return load(html);}
export async function promobitDetail(url,fetcher=fetch){
 const safe=offerUrl(url);if(!safe)throw new AppError('Link do Promobit inválido.');const $=await page(safe,fetcher);const id=new URL(safe).pathname.match(/-(\d+)\/?$/)?.[1];const p=products($).find(p=>String(p.sku)===id);const parsed=p&&productOffer(p);
 if(!parsed||!clean(p.name)||/oferta (?:encerrada|expirada)|promoção encerrada/i.test($('main button').text()))throw new AppError('Oferta encerrada ou dados atuais indisponíveis.',409);
 const description=clean(p.description);const title=clean(p.name);const image=photoUrl(p.image)||photoUrl($('meta[property="og:image"]').attr('content'));
 return {titulo:title,preco:brl.format(parsed.value),loja:clean(parsed.offer.seller?.name||parsed.offer.sellerName),link_original:safe,link_afiliado:'',fonte:'promobit',imagem:image,review:description?`Informações da oferta: ${description.slice(0,400)}${description.length>400?'…':''}`:'',observacao:`Preço informado pelo Promobit em ${new Date().toISOString()}. Confira preço final, cupom, variante e frete na loja.${!image?' Foto indisponível.':''}${!description?' Descrição indisponível.':''}${description.length>400?' Descrição resumida; leia as condições completas.':''}`};
}
export async function promobit(fetcher=fetch){
 const $=await page(PROMOBIT+'/',fetcher,10000);const candidates=new Map();let parsed=0;
 for(const p of products($)){const item=productOffer(p);if(!item)continue;const url=offerUrl(item.offer.url||p.url);if(!url)continue;parsed++;if(FITNESS.test(clean(p.name)))candidates.set(url,true);}
 $('a[href*="/oferta/"]').each((_,a)=>{const card=$(a),title=card.find('span[class*="line-clamp"]').first().text().trim();if(!title)return;parsed++;const url=offerUrl(card.attr('href'));if(url&&FITNESS.test(title))candidates.set(url,true);});
 if(!parsed)throw new AppError('Promobit mudou o HTML; revise o coletor.',502);
 const urls=[...candidates.keys()].slice(0,8),offers=[];let failed=0;
 for(let i=0;i<urls.length;i+=3){const results=await Promise.allSettled(urls.slice(i,i+3).map(url=>promobitDetail(url,fetcher)));for(const r of results){if(r.status==='fulfilled')offers.push(r.value);else if(r.reason?.status!==409)failed++;}}
 if(urls.length&&!offers.length&&failed)throw new AppError('Não foi possível consultar os detalhes das ofertas. Tente novamente.',502);
 return offers;
}
