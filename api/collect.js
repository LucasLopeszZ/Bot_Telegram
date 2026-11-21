import handler from './index.js';
// Vercel cron: the shared handler checks the bearer secret and production environment.
export default function collect(req,res){req.query={...req.query,op:'collect-cron'};return handler(req,res);}
