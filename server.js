const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const MAX_USOS = 3;
const VENTANA  = 24 * 60 * 60 * 1000;
const DB_FILE  = path.join(__dirname, 'usos.json');

// ── PON AQUÍ TU KEY DE GEMINI (gratis en aistudio.google.com) ────────────────
const GEMINI_KEY = process.env.GEMINI_KEY || 'AIzaSyB7nB961FWZeiXzmNJhjre55npYtx-P0AU';
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY;

function cargarDB(){ try{return JSON.parse(fs.readFileSync(DB_FILE,'utf8'));}catch(e){return {};} }
function guardarDB(db){ fs.writeFileSync(DB_FILE,JSON.stringify(db),'utf8'); }
function getIP(req){ return (req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim(); }

function consultarUsos(ip){
  const db=cargarDB(), now=Date.now(), reg=db[ip];
  if(!reg) return {usos:0,bloqueado:false,segundosRestantes:0};
  const diff=now-reg.desde;
  if(diff>=VENTANA){delete db[ip];guardarDB(db);return {usos:0,bloqueado:false,segundosRestantes:0};}
  const bloqueado=reg.usos>=MAX_USOS;
  return {usos:reg.usos,bloqueado,segundosRestantes:bloqueado?Math.ceil((VENTANA-diff)/1000):0};
}

function registrarUso(ip){
  const db=cargarDB(), now=Date.now(), reg=db[ip];
  if(!reg||(now-reg.desde)>=VENTANA) db[ip]={usos:1,desde:now};
  else db[ip].usos+=1;
  guardarDB(db);
  return db[ip].usos;
}

function leerBody(req){
  return new Promise((res,rej)=>{
    let data='';
    req.on('data',c=>data+=c);
    req.on('end',()=>res(data));
    req.on('error',rej);
  });
}

function llamarGemini(texto){
  return new Promise((resolve,reject)=>{
    const prompt=
      'Reescribe el siguiente texto en español para que suene completamente humano y natural. '+
      'Instrucciones:\n'+
      '- Varía mucho la longitud de las oraciones (mezcla cortas y largas)\n'+
      '- Usa vocabulario cotidiano y coloquial\n'+
      '- Añade expresiones naturales como "la verdad", "o sea", "fíjate que", "eso sí", "mira"\n'+
      '- Cambia el orden de las ideas y la estructura de los párrafos\n'+
      '- Usa voz activa, evita la pasiva\n'+
      '- Evita palabras típicas de IA: "fundamental", "óptimo", "implementar", "en conclusión", '+
      '"cabe destacar", "es importante señalar", "en el marco de", "a través de"\n'+
      '- Introduce alguna imperfección natural (coma de pausa, frase incompleta, muletilla)\n'+
      '- Devuelve SOLO el texto reescrito, sin explicaciones\n\n'+
      'TEXTO:\n'+texto;

    const body=JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      generationConfig:{temperature:1.1,maxOutputTokens:2048}
    });

    const options={
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    };

    const req=https.request(GEMINI_URL,options,(res)=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{
          const json=JSON.parse(data);
          if(json.error) return reject(new Error(json.error.message));
          resolve(json.candidates[0].content.parts[0].text.trim());
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject);
    req.write(body);
    req.end();
  });
}

const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json'};

http.createServer(async(req,res)=>{
  const parsed=url.parse(req.url,true);
  const ip=getIP(req);

  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  // GET /api/estado
  if(parsed.pathname==='/api/estado'&&req.method==='GET'){
    const e=consultarUsos(ip);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({...e,max:MAX_USOS}));
    return;
  }

  // POST /api/humanizar — registra uso Y llama a Gemini
  if(parsed.pathname==='/api/humanizar'&&req.method==='POST'){
    const estado=consultarUsos(ip);
    if(estado.bloqueado){
      res.writeHead(429,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'limite',segundosRestantes:estado.segundosRestantes}));
      return;
    }
    try{
      const rawBody=await leerBody(req);
      const {texto}=JSON.parse(rawBody);
      if(!texto||!texto.trim()){res.writeHead(400);res.end(JSON.stringify({error:'texto vacío'}));return;}

      let resultado;
      if(GEMINI_KEY==='PEGA_TU_KEY_AQUI'){
        // Sin key configurada: devolver error claro
        res.writeHead(503,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Gemini key no configurada en el servidor'}));
        return;
      }
      resultado=await llamarGemini(texto);
      const usos=registrarUso(ip);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({resultado,usos,max:MAX_USOS,bloqueado:usos>=MAX_USOS}));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // Archivos estáticos
  let filePath=parsed.pathname==='/'?'/index.html':parsed.pathname;
  filePath=path.join(__dirname,filePath);
  fs.readFile(filePath,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    const ext=path.extname(filePath);
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream'});
    res.end(data);
  });

}).listen(PORT,()=>{
  console.log('HumanizaIA en http://localhost:'+PORT);
  if(GEMINI_KEY==='PEGA_TU_KEY_AQUI')
    console.warn('⚠️  GEMINI_KEY no configurada. Edita server.js o usa: GEMINI_KEY=tu_key node server.js');
  else
    console.log('✓ Gemini configurado');
});
