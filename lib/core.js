import {createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv} from 'node:crypto';
export class AppError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export const random = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const equal = (a,b) => timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export function validUrl(v){try{const u=new URL(v);return typeof v==='string'&&!/\s/.test(v)&&['http:','https:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch{return false;}}
export function canonical(v){if(!validUrl(v))throw new AppError('Link original inválido.');const u=new URL(v);u.protocol='https:';u.hash='';u.pathname=u.pathname.replace(/\/+$/,'')||'/';for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(k))u.searchParams.delete(k);u.searchParams.sort();return u.href;}
// Only exact announcement IDs and canonical URLs identify duplicates; never titles.
export function offerKeys(o){
 const keys=new Set();
 if(o.fonte==='mercado_livre'&&/^MLB\d+$/.test(o.external_id||''))keys.add('meli:'+o.external_id);
 for(const value of [o.link_original,o.link_afiliado]){
  if(!validUrl(value))continue;
  keys.add('url:'+canonical(value));
  const u=new URL(value);
  if(u.hostname==='produto.mercadolivre.com.br'){
   const item=u.pathname.match(/^\/MLB-?(\d+)(?:-|\/|$)/i);
   if(item)keys.add('meli:MLB'+item[1]);
  }
 }
 return [...keys];
}
export function couponData(o){
 const out={};for(const [key,max] of [['cupom',80],['cupom_condicoes',300],['cupom_validade',16]]){const value=o[key]??'';if(typeof value!=='string'||value.length>max)throw new AppError('Dados do cupom inválidos.');out[key]=value.trim();}
 if(out.cupom_validade)couponDeadline(out.cupom_validade);
 return out;
}
export function couponDeadline(value){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new AppError('Informe data e horário válidos para o cupom (Brasília).');
 const ms=Date.parse(value+'-03:00');
 if(!Number.isFinite(ms)||new Date(ms-3*3600000).toISOString().slice(0,16)!==value)throw new AppError('Data de validade do cupom inválida.');
 return ms;
}
export function checkCoupon(o,now=Date.now()){
 const c=couponData(o);let message='';
 if(!c.cupom&&(c.cupom_condicoes||c.cupom_validade))message='Informe o código do cupom ou limpe seus dados.';
 else if(c.cupom&&!c.cupom_validade)message='Informe a validade do cupom antes de aprovar.';
 else if(c.cupom&&couponDeadline(c.cupom_validade)<=now)message='Cupom vencido. Atualize o cupom e o preço antes de aprovar novamente.';
 if(message){const e=new AppError(message,409);e.code='COUPON';throw e;}
}
export function normalize(o){
 if(!o||typeof o!=='object')throw new AppError('Oferta inválida.');
 if(o.imagem&&(!validUrl(o.imagem)||o.imagem.length>2000))throw new AppError('Use um link HTTP(S) direto para a foto.');
 if(o.review&&(typeof o.review!=='string'||o.review.length>500))throw new AppError('O review deve ter até 500 caracteres.');
 if(!o||typeof o!=='object'||typeof o.titulo!=='string'||!o.titulo.trim()||o.titulo.length>600)throw new AppError('Oferta sem título válido.');
 if(String(o.preco??'').length>100)throw new AppError('Preço / benefício deve ter até 100 caracteres.');
 const link=canonical(o.link_original);const ext=o.fonte==='mercado_livre'&&/^MLB\d+$/.test(o.external_id||'')?o.external_id:null;
 return {id:hash(ext?'mercado_livre:'+ext:link),titulo:o.titulo.trim(),preco:String(o.preco??''),loja:String(o.loja||'').slice(0,100),link_original:link,link_afiliado:validUrl(o.link_afiliado)?o.link_afiliado:'',fonte:String(o.fonte||'importada').slice(0,50),external_id:ext,observacao:String(o.observacao||'').slice(0,300),imagem:o.imagem||'',review:o.review?.trim()||'',...couponData(o),preco_conferido_em:Number.isFinite(o.preco_conferido_em)?o.preco_conferido_em:null};
}
export function validateEdit(o,changes){
 if(Object.keys(changes).some(k=>!['id','version','titulo','preco','link_afiliado','imagem','review','cupom','cupom_condicoes','cupom_validade','preco_conferido','action'].includes(k)))throw new AppError('Campo não permitido.');
 if(!['pendente','aprovado','erro','descartado'].includes(o.estado))throw new AppError('Confira o envio antes de editar.',409);
 if(changes.action==='restaurar'){if(o.estado!=='descartado')throw new AppError('Somente ofertas descartadas podem ser restauradas.',409);return {...o,estado:'pendente',preco_conferido_em:null};}
 if(changes.action==='descartar')return {...o,estado:'descartado',preco_conferido_em:null};
 if('preco_conferido' in changes&&typeof changes.preco_conferido!=='boolean')throw new AppError('Confirmação de preço inválida.');
 const out={...o,preco_conferido_em:changes.action==='aprovar'&&changes.preco_conferido===true?Date.now():null};for(const key of ['titulo','preco','link_afiliado','imagem','review','cupom','cupom_condicoes','cupom_validade'])if(key in changes){if(typeof changes[key]!=='string'||changes[key].length>(['link_afiliado','imagem'].includes(key)?2000:key==='review'?500:600))throw new AppError('Campo inválido.');out[key]=changes[key].trim();}
 if(!out.titulo)throw new AppError('Título obrigatório.');
 if(!['salvar','aprovar','descartar'].includes(changes.action))throw new AppError('Ação inválida.');
 out.estado=changes.action==='aprovar'?'aprovado':changes.action==='descartar'?'descartado':'pendente';
 if(out.estado==='aprovado'&&!validUrl(out.link_afiliado))throw new AppError('Preencha um link de afiliado HTTP(S) válido.');
 if(out.estado==='aprovado')formatPost(out);
 return out;
}
const esc=v=>String(v).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export function formatPost(o){
 checkCoupon(o);if(!validUrl(o.link_afiliado))throw new AppError('Link de afiliado obrigatório.');if(o.imagem&&!validUrl(o.imagem))throw new AppError('Foto inválida.');
 const parts=[
  '🚨 <b>OFERTA EM DESTAQUE</b> 🚨',
  `🛍️ <b>${esc(o.titulo)}</b>`,
  o.preco?`💥 <b>POR APENAS ${esc(o.preco)}</b> 🔥`:'',
  o.loja?`🏪 <b>Loja:</b> ${esc(o.loja)}`:'',
  o.review?`✨ ${esc(o.review)}`:'',
  o.cupom?`🎟️ <b>CUPOM:</b> ${esc(o.cupom)}`:'',
  o.cupom_condicoes?`📌 ${esc(o.cupom_condicoes)}`:'',
  o.cupom_validade?`⏳ Válido até ${esc(o.cupom_validade.slice(0,10).split('-').reverse().join('/'))} às ${esc(o.cupom_validade.slice(11))} (Brasília)`:'',
  '⚠️ Preço e disponibilidade podem mudar a qualquer momento.',
  `🛒 <a href="${esc(o.link_afiliado)}"><b>QUERO APROVEITAR</b></a>`
 ].filter(Boolean);
 if(parts.join('\n\n').length>(o.imagem?1024:4000))throw new AppError(o.imagem?'Reduza título ou review: a legenda da foto aceita até 1024 caracteres.':'Mensagem longa demais.');return parts.join('\n\n');
}
export function encrypt(value,key){if(!/^[a-f\d]{64}$/i.test(key||''))throw new AppError('Configure TOKEN_ENCRYPTION_KEY com 64 caracteres hexadecimais.',503);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(x=>x.toString('base64url')).join('.');}
export function decrypt(value,key){const [iv,tag,body]=value.split('.').map(x=>Buffer.from(x,'base64url'));const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(body),cipher.final()]).toString('utf8'));}
async function telegramRequest(method,payload,env,fetcher){
 let response,data={};
 try{response=await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});try{data=await response.json();}catch{}}catch{return {network:true};}
 return {response,data};
}
function telegramProblem(status){
 if(status===401)return 'Telegram recusou o token do bot. Confira TELEGRAM_BOT_TOKEN no servidor.';
 if(status===403)return 'O bot não pode publicar neste canal. Confirme se ele é administrador e se TELEGRAM_CHAT_ID corresponde ao canal.';
 if(status===429)return 'O Telegram limitou temporariamente os envios. Aguarde alguns minutos e aprove novamente.';
 if(status===400)return 'O Telegram recusou a mensagem. Confira o link da foto, o canal e o conteúdo da oferta.';
 return `Telegram recusou o envio (HTTP ${status}). Confira a configuração do canal e aprove novamente.`;
}
export async function telegram(o,env,fetcher=fetch){
 const text=formatPost(o),photo=!!o.imagem;
 const first=await telegramRequest(photo?'sendPhoto':'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,parse_mode:'HTML',...(photo?{photo:o.imagem,caption:text}:{text})},env,fetcher);
 if(first.network)return {estado:'incerto',erro:'Sem confirmação do Telegram. Confira o canal antes de liberar novamente.'};
 if(first.response.ok&&first.data.ok===true&&Number.isInteger(first.data.result?.message_id))return {estado:'publicado',message_id:first.data.result.message_id};
 const description=String(first.data?.description||'').toLowerCase();
 const rejectedPhoto=photo&&first.response.status===400&&/(photo|image|http url|file)/.test(description);
 if(rejectedPhoto){
  const fallback=await telegramRequest('sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,parse_mode:'HTML',text},env,fetcher);
  if(fallback.network)return {estado:'incerto',erro:'A foto foi recusada e o texto ficou sem confirmação. Confira o canal antes de liberar novamente.'};
  if(fallback.response.ok&&fallback.data.ok===true&&Number.isInteger(fallback.data.result?.message_id))return {estado:'publicado',message_id:fallback.data.result.message_id,aviso:'A foto foi recusada pelo Telegram; a oferta foi publicada somente com texto.'};
  if(fallback.response.status>=400&&fallback.response.status<500)return {estado:'erro',erro:telegramProblem(fallback.response.status)};
  return {estado:'incerto',erro:'O Telegram não confirmou o envio do texto. Confira o canal antes de liberar novamente.'};
 }
 if(first.response.status>=400&&first.response.status<500)return {estado:'erro',erro:telegramProblem(first.response.status)};
 return {estado:'incerto',erro:'O Telegram não confirmou o envio. Confira o canal antes de liberar novamente.'};
}
