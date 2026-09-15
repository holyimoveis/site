export const config = { runtime: 'edge' };
export default function handler() {
  return new Response(JSON.stringify({success:true,status:'online',site:'holyimoveis.com',version:'2.0'}),{
    headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}
  });
}
