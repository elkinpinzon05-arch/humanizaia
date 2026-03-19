const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const MAX_USOS = 3;
const VENTANA  = 24 * 60 * 60 * 1000;
const DB_FILE  = path.join(__dirname, 'usos.json');
const PRO_FILE = path.join(__dirname, 'pros.json');

const GEMINI_KEY = process.env.GEMINI_KEY || 'AIzaSyB7nB961FWZeiXzmNJhjre55npYtx-P0AU';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || ''; // Token de MercadoPago (producción)

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_KEY;

// ── DB helpers ────────────────────────────────────────────────────────────────
function cargarDB(){ try{return JSON.parse(fs.readFileSync(DB_FILE,'utf8'));}catch(e){return {};} }
function guardarDB(db){ fs.writeFileSync(DB_FILE,JSON.stringify(db),'utf8'); }
function cargarPros(){ try{return JSON.parse(fs.readFileSync(PRO_FILE,'utf8'));}catch(e){return {};} }
function guardarPros(pros){ fs.writeFileSync(PRO_FILE,JSON.stringify(pros),'utf8'); }
function getIP(req){ return (req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim(); }

// ── Usos gratuitos ────────────────────────────────────────────────────────────
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

// ── Pro helpers ───────────────────────────────────────────────────────────────
function esPro(ip){
  const pros=cargarPros();
  const reg=pros[ip];
  if(!reg) return false;
  if(reg.expira && Date.now() > reg.expira) return false;
  return true;
}

function activarPro(ip, email, plan){
  const pros=cargarPros();
  const expira = plan==='mensual'
    ? Date.now() + 31*24*60*60*1000
    : Date.now() + 366*24*60*60*1000;
  pros[ip]={ email: email||'', plan: plan||'mensual', expira, activado: Date.now() };
  guardarPros(pros);
  console.log('✓ Pro activado:', ip, email, plan);
}

// ── Gemini ────────────────────────────────────────────────────────────────────
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

// ── Verificar pago en MercadoPago ─────────────────────────────────────────────
function verificarPagoMP(paymentId){
  return new Promise((resolve,reject)=>{
    if(!MP_ACCESS_TOKEN){ return reject(new Error('MP_ACCESS_TOKEN no configurado')); }
    const options={
      hostname:'api.mercadopago.com',
      path:'/v1/payments/'+paymentId,
      method:'GET',
      headers:{ 'Authorization':'Bearer '+MP_ACCESS_TOKEN }
    };
    const req=https.request(options,(res)=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{ resolve(JSON.parse(data)); }catch(e){ reject(e); }
      });
    });
    req.on('error',reject);
    req.end();
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
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
    const pro=esPro(ip);
    const e=pro?{usos:0,bloqueado:false,segundosRestantes:0}:consultarUsos(ip);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({...e,max:MAX_USOS,pro}));
    return;
  }

  // POST /api/humanizar
  if(parsed.pathname==='/api/humanizar'&&req.method==='POST'){
    const pro=esPro(ip);
    if(!pro){
      const estado=consultarUsos(ip);
      if(estado.bloqueado){
        res.writeHead(429,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'limite',segundosRestantes:estado.segundosRestantes}));
        return;
      }
    }
    try{
      const rawBody=await leerBody(req);
      const {texto}=JSON.parse(rawBody);
      if(!texto||!texto.trim()){res.writeHead(400);res.end(JSON.stringify({error:'texto vacío'}));return;}

      // Límite de palabras según plan
      const palabras=texto.trim().split(/\s+/).length;
      const limiteMax=pro?1000:100;
      if(palabras>limiteMax){
        res.writeHead(400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'palabras_excedidas',limite:limiteMax}));
        return;
      }

      const resultado=await llamarGemini(texto);
      const usos=pro?0:registrarUso(ip);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({resultado,usos,max:MAX_USOS,bloqueado:!pro&&usos>=MAX_USOS,pro}));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }

  // POST /api/webhook-mp  — MercadoPago notifica pagos aquí
  if(parsed.pathname==='/api/webhook-mp'&&req.method==='POST'){
    try{
      const rawBody=await leerBody(req);
      const notif=JSON.parse(rawBody);
      console.log('Webhook MP recibido:', JSON.stringify(notif));

      // MercadoPago envía type="payment" con data.id
      if(notif.type==='payment'&&notif.data&&notif.data.id){
        const pago=await verificarPagoMP(notif.data.id);
        console.log('Pago verificado:', pago.status, pago.payer&&pago.payer.email);

        if(pago.status==='approved'){
          const email=pago.payer&&pago.payer.email||'';
          // Determinar plan por monto
          const monto=pago.transaction_amount||0;
          const plan=monto<=25000?'mensual':'anual';
          // Guardar por email como clave (más confiable que IP)
          if(email){
            const pros=cargarPros();
            const expira=plan==='mensual'
              ? Date.now()+31*24*60*60*1000
              : Date.now()+366*24*60*60*1000;
            pros['email:'+email]={email,plan,expira,activado:Date.now(),paymentId:notif.data.id};
            guardarPros(pros);
            console.log('✓ Pro activado por email:', email, plan);
          }
        }
      }
      res.writeHead(200);res.end('OK');
    }catch(e){
      console.error('Error webhook:', e.message);
      res.writeHead(200);res.end('OK'); // siempre 200 para MP
    }
    return;
  }

  // POST /api/activar-pro  — el usuario ingresa su email tras pagar
  if(parsed.pathname==='/api/activar-pro'&&req.method==='POST'){
    try{
      const rawBody=await leerBody(req);
      const {email}=JSON.parse(rawBody);
      if(!email||!email.includes('@')){
        res.writeHead(400,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Email inválido'}));
        return;
      }
      const pros=cargarPros();
      const reg=pros['email:'+email.toLowerCase().trim()];
      if(!reg){
        res.writeHead(404,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'No se encontró pago para ese email'}));
        return;
      }
      if(reg.expira && Date.now()>reg.expira){
        res.writeHead(403,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Suscripción vencida'}));
        return;
      }
      // Vincular IP actual con la cuenta Pro
      pros[ip]={...reg, ipActivada: Date.now()};
      guardarPros(pros);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,plan:reg.plan,expira:reg.expira}));
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
  console.log('✓ Gemini configurado');
  if(!MP_ACCESS_TOKEN) console.warn('⚠️  MP_ACCESS_TOKEN no configurado — webhook de pagos inactivo');
});
