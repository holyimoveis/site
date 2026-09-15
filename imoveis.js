// Vercel KV API — /api/imoveis
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Content-Type': 'application/json',
  };

  if (req.method === 'OPTIONS') return new Response('', { headers });

  const KV_URL     = process.env.KV_REST_API_URL;
  const KV_TOKEN   = process.env.KV_REST_API_TOKEN;
  const API_KEY    = process.env.CRM_API_KEY || 'holy_crm_2025';

  async function kv(cmd, ...args) {
    const r = await fetch(`${KV_URL}/${[cmd, ...args].map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const d = await r.json();
    return d.result;
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const status = url.searchParams.get('status');
      const cidade = url.searchParams.get('cidade');

      const ids = (await kv('lrange','imoveis:ids','0','-1')) || [];
      if (!ids.length) return new Response(JSON.stringify({success:true,data:[],total:0}),{headers});

      const items = await Promise.all(ids.map(id => kv('hgetall', `imovel:${id}`)));
      let data = items.filter(Boolean).map(im => {
        if (Array.isArray(im)) {
          const obj = {};
          for (let i=0;i<im.length;i+=2) obj[im[i]]=im[i+1];
          return obj;
        }
        return im;
      });
      if (status) data = data.filter(im => im.status === status);
      if (cidade) data = data.filter(im => im.cidade === cidade);
      return new Response(JSON.stringify({success:true,data,total:data.length}),{headers});
    }

    if (req.method === 'POST') {
      const apiKey = req.headers.get('x-api-key') || '';
      if (apiKey !== API_KEY) return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers});

      const im = await req.json();
      if (!im.id || !im.nome) return new Response(JSON.stringify({error:'id e nome obrigatórios'}),{status:400,headers});

      const flat = Object.entries(im).flat();
      await kv('hset', `imovel:${im.id}`, ...flat);
      const pos = await kv('lpos','imoveis:ids',im.id);
      if (pos === null) await kv('lpush','imoveis:ids',im.id);
      return new Response(JSON.stringify({success:true,id:im.id}),{headers});
    }

    if (req.method === 'DELETE') {
      const apiKey = req.headers.get('x-api-key') || '';
      if (apiKey !== API_KEY) return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers});
      const url = new URL(req.url);
      const id = url.searchParams.get('id');
      if (!id) return new Response(JSON.stringify({error:'id obrigatório'}),{status:400,headers});
      await kv('del', `imovel:${id}`);
      await kv('lrem','imoveis:ids','0',id);
      return new Response(JSON.stringify({success:true}),{headers});
    }
  } catch(err) {
    return new Response(JSON.stringify({error:err.message}),{status:500,headers});
  }
}
