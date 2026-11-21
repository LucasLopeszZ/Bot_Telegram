import handler from './index.js';
export default function callback(req,res){req.query={...req.query,op:'meli-callback'};return handler(req,res);}
