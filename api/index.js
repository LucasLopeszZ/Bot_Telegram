import {connection,Repository} from '../lib/db.js';
import {createService} from '../lib/service.js';
import {AppError} from '../lib/core.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{const result=await createService(new Repository(connection())).run(req);if(result.cookie)res.setHeader('Set-Cookie',result.cookie);if(result.redirect)return res.redirect(303,result.redirect);return res.status(200).json(result.data);}
 catch(e){return res.status(e instanceof AppError?e.status:500).json({erro:e instanceof AppError?e.message:'Operação não concluída. Confira a configuração do servidor e tente novamente.'});}
}
