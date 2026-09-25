import {createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv} from 'node:crypto';
export class AppError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export const random = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const equal = (a,b) => timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export function validUrl(v){try{const u=new URL(v);return typeof v==='string'&&!/\s/.test(v)&&['http:','https:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch{return false;}}
export function canonical(v){if(!validUrl(v))throw new AppError('Link original inválido.');const u=new URL(v);u.protocol='https:';u.hash='';u.pathname=u.pathname.replace(/\/+$/,'')||'/';for(const k of [...u.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(k))u.searchParams.delete(k);u.searchParams.sort();return u.href;}
export function normalize(o){
 if(o.imagem&&(!validUrl(o.imagem)||o.imagem.length>2000))throw new AppError('Use um link HTTP(S) direto para a foto.');
 if(o.review&&(typeof o.review!=='string'||o.review.length>500))throw new AppError('O review deve ter até 500 caracteres.');
 if(!o||typeof o!=='object'||typeof o.titulo!=='string'||!o.titulo.trim()||o.titulo.length>600)throw new AppError('Oferta sem título válido.');
 const link=canonical(o.link_original);const ext=o.fonte==='mercado_livre'&&/^MLB\d+$/.test(o.external_id||'')?o.external_id:null;
 return {id:hash(ext?'mercado_livre:'+ext:link),titulo:o.titulo.trim(),preco:String(o.preco||'').slice(0,100),loja:String(o.loja||'').slice(0,100),link_original:link,link_afiliado:validUrl(o.link_afiliado)?o.link_afiliado:'',fonte:String(o.fonte||'importada').slice(0,50),external_id:ext,observacao:String(o.observacao||'').slice(0,300),imagem:o.imagem||'',review:o.review?.trim()||''};
}
export function validateEdit(o,changes){
 if(Object.keys(changes).some(k=>!['id','version','titulo','preco','link_afiliado','imagem','review','action'].includes(k)))throw new AppError('Campo não permitido.');
 if(!['pendente','aprovado','erro','descartado'].includes(o.estado))throw new AppError('Confira o envio antes de editar.',409);
 const out={...o};for(const key of ['titulo','preco','link_afiliado','imagem','review'])if(key in changes){if(typeof changes[key]!=='string'||changes[key].length>(['link_afiliado','imagem'].includes(key)?2000:key==='review'?500:600))throw new AppError('Campo inválido.');out[key]=changes[key].trim();}
 if(!out.titulo)throw new AppError('Título obrigatório.');
 if(!['salvar','aprovar','descartar'].includes(changes.action))throw new AppError('Ação inválida.');
 out.estado=changes.action==='aprovar'?'aprovado':changes.action==='descartar'?'descartado':'pendente';
 if(out.estado==='aprovado'&&!validUrl(out.link_afiliado))throw new AppError('Preencha um link de afiliado HTTP(S) válido.');
 if(out.estado==='aprovado')formatPost(out);
 return out;
}
const esc=v=>String(v).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export function formatPost(o){if(!validUrl(o.link_afiliado))throw new AppError('Link de afiliado obrigatório.');if(o.imagem&&!validUrl(o.imagem))throw new AppError('Foto inválida.');const parts=[`🏃 ${o.titulo}`,o.preco?`💰 ${o.preco}`:'',o.loja?`🏬 ${o.loja}`:'',o.review?`📝 ${o.review}`:'','Confira preço e disponibilidade na loja.','Ver oferta','Publicidade · Link de afiliado: podemos receber comissão pela compra.'].filter(Boolean);if(parts.join('\n\n').length>(o.imagem?1024:4000))throw new AppError(o.imagem?'Reduza título ou review: a legenda da foto aceita até 1024 caracteres.':'Mensagem longa demais.');return parts.map((p,i)=>i===0?`🏃 <b>${esc(o.titulo)}</b>`:p==='Ver oferta'?`<a href="${esc(o.link_afiliado)}">Ver oferta</a>`:esc(p)).join('\n\n');}
export function encrypt(value,key){if(!/^[a-f\d]{64}$/i.test(key||''))throw new AppError('Configure TOKEN_ENCRYPTION_KEY com 64 caracteres hexadecimais.',503);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(x=>x.toString('base64url')).join('.');}
export function decrypt(value,key){const [iv,tag,body]=value.split('.').map(x=>Buffer.from(x,'base64url'));const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(body),cipher.final()]).toString('utf8'));}
export async function telegram(o,env,fetcher=fetch){
 const text=formatPost(o);let response,data;
 const payload={chat_id:env.TELEGRAM_CHAT_ID,parse_mode:'HTML',...(o.imagem?{photo:o.imagem,caption:text}:{text})};
 try{response=await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${o.imagem?'sendPhoto':'sendMessage'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});data=await response.json();}catch{return {estado:'incerto',erro:'Sem confirmação. Confira o canal antes de liberar novamente.'};}
 if(response.ok&&data.ok===true&&Number.isInteger(data.result?.message_id))return {estado:'publicado',message_id:data.result.message_id};
 if(response.status>=400&&response.status<500&&data.ok===false)return {estado:'erro',erro:`Telegram recusou o envio (HTTP ${response.status}). Corrija e aprove novamente.`};
 return {estado:'incerto',erro:'Resultado não confirmado pelo Telegram. Confira o canal.'};
}
