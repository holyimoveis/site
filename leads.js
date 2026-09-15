export const config = { runtime: 'edge' };
export default async function handler(req) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Content-Type': 'application/json',
  };
  if (req.method === 'OPTIONS') return new Response('', { headers });

  const KV_URL   = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  const API_KEY  = process.env.CRM_API_KEY || 'holy_crm_2025';

  async function kv(cmd, ...args) {
    const r = await fetch(`${KV_URL}/${[cmd,...args].map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    return (await r.json()).result;
  }

  try {
    if (req.method === 'POST') {
      const body = await req.json();
      if (!body.nome) return new Response(JSON.stringify({error:'Nome obrigatório'}),{status:400,headers});
      const lead = { ...body, id:'lead_'+Date.now(), data:new Date().toISOString() };
      await kv('hset',`lead:${lead.id}`,...Object.entries(lead).flat());
      await kv('lpush','leads:ids',lead.id);
      return new Response(JSON.stringify({success:true,message:'Recebemos seu contato! Falaremos em breve.'}),{headers});
    }
    if (req.method === 'GET') {
      if ((req.headers.get('x-api-key')||'') !== API_KEY) return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers});
      const ids = (await kv('lrange','leads:ids','0','99')) || [];
      const items = await Promise.all(ids.map(id=>kv('hgetall',`lead:${id}`)));
      const data = items.filter(Boolean).map(im=>{if(Array.isArray(im)){const o={};for(let i=0;i<im.length;i+=2)o[im[i]]=im[i+1];return o;}return im;});
      return new Response(JSON.stringify({success:true,data,total:data.length}),{headers});
    }
  } catch(err) {
    return new Response(JSON.stringify({error:err.message}),{status:500,headers});
  }
}
