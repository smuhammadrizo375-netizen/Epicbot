const express=require('express'),fs=require('fs');
const app=express();app.use(express.json());app.use(express.static('public'));
const F=process.env.DB_PATH||'db.json',ADMIN=process.env.ADMIN_PASSWORD||'admin123';
let db={users:{},promos:{},contests:{},history:[],stats:{bets:0,wagered:0,paid:0}};
try{db=Object.assign(db,JSON.parse(fs.readFileSync(F)))}catch{}
let dirty=false;const save=()=>{dirty=true};
setInterval(()=>{if(dirty){dirty=false;fs.writeFile(F,JSON.stringify(db),()=>{})}},3000);

const MIN=1000,START=10000,RATE=0.1,games={};   // RATE: o'sish tezligi (200x ~ 53 soniya)
const mult=g=>Math.floor(Math.exp(RATE*(Date.now()-g.t0)/1000)*100)/100;
// P(>=2x)=30%, 40% darrov 1.00x da yonadi, maksimum 200x
function crashPoint(){const u=Math.random();return u>=0.6?1:Math.min(200,Math.max(1,Math.floor(0.6/u*100)/100))}
const clean=s=>String(s||'').replace(/[^\w\-]/g,'').slice(0,40);
const crypto=require('crypto');
const TOKEN=process.env.BOT_TOKEN||'',ADMIN_IDS=(process.env.ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
// Telegram initData imzosini tekshirish (soxta ID'dan himoya)
function tgUser(init){if(!TOKEN||!init)return null;
  const p=new URLSearchParams(init),h=p.get('hash');p.delete('hash');
  const str=[...p.entries()].map(([k,v])=>k+'='+v).sort().join('\n');
  const key=crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();
  if(!h||crypto.createHmac('sha256',key).update(str).digest('hex')!==h)return null;
  if(Date.now()/1000-(+p.get('auth_date')||0)>86400)return null;
  try{return JSON.parse(p.get('user'))}catch{return null}}
function ident(req){const t=tgUser(req.headers['x-init']);
  if(t)return{id:'tg'+t.id,name:t.first_name||t.username||'Player',tg:String(t.id)};
  if(TOKEN&&process.env.ALLOW_GUEST==='0')return null;
  const id=clean(req.headers['x-uid']);return id&&!id.startsWith('tg')?{id,name:'Guest'}:null}
function me(req){const i=ident(req);if(!i)return null;
  if(!db.users[i.id]){db.users[i.id]={id:i.id,name:i.name,balance:START,created:Date.now(),games:0};save()}
  const u=db.users[i.id];if(i.tg&&u.name!==i.name){u.name=i.name;save()}u.tg=i.tg;return u}
const auth=(q,s,n)=>{const u=me(q);if(!u)return s.status(401).json({error:'Kirish rad etildi'});q.u=u;n()};
const isAdm=q=>{const i=ident(q);return !!(i&&i.tg&&ADMIN_IDS.includes(i.tg))};
const adm=(q,s,n)=>(q.headers['x-admin']===ADMIN||isAdm(q))?n():s.status(403).json({error:'Ruxsat yo\'q'});
app.get('/api/is-admin',(q,s)=>s.json({admin:isAdm(q)}));
// Telegram bot (webhook)
const TGURL=process.env.WEBAPP_URL||process.env.RENDER_EXTERNAL_URL,WH=crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0,32);
const tgApi=(m,b)=>fetch(`https://api.telegram.org/bot${TOKEN}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
if(TOKEN&&TGURL){
  const esc=x=>String(x||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  app.post('/tg/'+WH,(q,s)=>{s.sendStatus(200);const m=q.body.message;
    if(m&&m.text&&m.text.startsWith('/start'))tgApi('sendMessage',{chat_id:m.chat.id,parse_mode:'HTML',
      text:`👋 Salom, <b>${esc(m.from&&m.from.first_name)}</b>!\n\n🚀 <b>Epic Raketa</b> — demo o\'yin. Haqiqiy pul yo\'q, faqat o\'yin uchun ⭐.\n\n🎁 Boshlang\'ich balans: <b>10 000 ⭐</b>\n🎯 Minimal stavka: <b>1 000 ⭐</b>\n📋 Vazifalarni bajaring, promokod kiriting va konkurslarda qatnashing!\n\nBoshlash uchun pastdagi tugmani bosing 👇`,
      reply_markup:{inline_keyboard:[[{text:'🚀 O\'ynash',web_app:{url:TGURL}}]]}}).catch(()=>{})});
  tgApi('setWebhook',{url:TGURL+'/tg/'+WH}).then(r=>console.log('webhook',r.ok)).catch(console.error);
  tgApi('setMyCommands',{commands:[{command:'start',description:'O\'yinni boshlash'}]}).catch(()=>{});
  tgApi('setChatMenuButton',{menu_button:{type:'web_app',text:'O\'ynash',web_app:{url:TGURL}}}).catch(()=>{});
}

app.post('/api/me',auth,(q,s)=>{if(q.body.name&&!q.u.tg)q.u.name=String(q.body.name).slice(0,24);save();s.json(q.u)});
app.get('/api/history',(q,s)=>s.json(db.history.slice(-20).reverse()));
app.get('/api/top',(q,s)=>s.json(Object.values(db.users).sort((a,b)=>b.balance-a.balance).slice(0,20).map(u=>({name:u.name,balance:u.balance}))));

app.post('/api/bet',auth,(q,s)=>{const u=q.u,a=Math.floor(+q.body.amount);
  if(games[u.id])return s.status(400).json({error:'O\'yin davom etmoqda'});
  if(!(a>=MIN))return s.status(400).json({error:`Minimal stavka ${MIN}`});
  if(a>u.balance)return s.status(400).json({error:'Balans yetarli emas'});
  u.balance-=a;u.games++;db.stats.bets++;db.stats.wagered+=a;games[u.id]={bet:a,t0:Date.now(),crash:crashPoint()};save();
  s.json({balance:u.balance})});
function finish(u,g,win){delete games[u.id];if(!win)db.history.push(g.crash);if(db.history.length>100)db.history.shift();save()}
app.get('/api/status',auth,(q,s)=>{const g=games[q.u.id];if(!g)return s.json({state:'idle'});
  const m=mult(g);if(m>=g.crash){finish(q.u,g,false);return s.json({state:'crashed',crash:g.crash})}
  s.json({state:'run',m,elapsed:Date.now()-g.t0})});
app.post('/api/cash',auth,(q,s)=>{const u=q.u,g=games[u.id];if(!g)return s.status(400).json({error:'O\'yin yo\'q'});
  const m=mult(g);if(m>=g.crash){finish(u,g,false);return s.json({state:'crashed',crash:g.crash})}
  const win=Math.floor(g.bet*m);u.balance+=win;db.stats.paid+=win;db.history.push(g.crash);finish(u,g,true);
  s.json({state:'won',m,win,balance:u.balance,crash:g.crash})});

app.post('/api/promo',auth,(q,s)=>{const p=db.promos[clean(q.body.code).toUpperCase()];
  if(!p||p.left<=0)return s.status(400).json({error:'Promokod yaroqsiz'});
  if(p.used.includes(q.u.id))return s.status(400).json({error:'Allaqachon ishlatilgan'});
  p.left--;p.used.push(q.u.id);q.u.balance+=p.amount;save();s.json({balance:q.u.balance,amount:p.amount})});
app.get('/api/contests',auth,(q,s)=>s.json(Object.values(db.contests).map(c=>({id:c.id,title:c.title,prize:c.prize,done:c.done,
  winner:c.winnerName,count:c.players.length,joined:c.players.includes(q.u.id)}))));
app.post('/api/contests/join',auth,(q,s)=>{const c=db.contests[q.body.id];
  if(!c||c.done)return s.status(400).json({error:'Konkurs yopilgan'});
  if(!c.players.includes(q.u.id))c.players.push(q.u.id);save();s.json({ok:1})});

// ---------- VAZIFALAR ----------
const TASKS=[
 {id:'daily',title:'Kunlik bonus',desc:'Har 24 soatda bir marta',reward:2000,repeat:24*3600e3},
 {id:'g5',title:'5 ta o\'yin o\'ynang',desc:'Raketada jami 5 ta stavka qiling',reward:5000,need:5},
 {id:'g25',title:'25 ta o\'yin o\'ynang',desc:'Raketada jami 25 ta stavka qiling',reward:25000,need:25}];
function taskState(u){u.claimed=u.claimed||{};return TASKS.map(t=>{const last=u.claimed[t.id]||0;let st,left=0;
  if(t.repeat){left=Math.max(0,last+t.repeat-Date.now());st=left?'wait':'ready'}
  else st=last?'done':((u.games||0)>=t.need?'ready':'todo');
  return{id:t.id,title:t.title,desc:t.desc,reward:t.reward,status:st,left,need:t.need||null,progress:t.need?Math.min(u.games||0,t.need):null}})}
app.get('/api/tasks',auth,(q,s)=>s.json(taskState(q.u)));
app.post('/api/tasks/claim',auth,(q,s)=>{const t=TASKS.find(x=>x.id===q.body.id),st=t&&taskState(q.u).find(x=>x.id===t.id);
  if(!st||st.status!=='ready')return s.status(400).json({error:'Vazifa hali bajarilmagan'});
  q.u.claimed[t.id]=Date.now();q.u.balance+=t.reward;save();s.json({balance:q.u.balance,reward:t.reward})});

// ---------- ADMIN ----------
const A='/api/admin';
app.get(A+'/stats',adm,(q,s)=>{const us=Object.values(db.users);
  s.json({users:us.length,balance:us.reduce((a,u)=>a+u.balance,0),active24h:0,...db.stats,
  promos:Object.keys(db.promos).length,contests:Object.keys(db.contests).length})});
app.get(A+'/users',adm,(q,s)=>{const t=String(q.query.q||'').toLowerCase();
  s.json(Object.values(db.users).filter(u=>!t||u.id.includes(t)||u.name.toLowerCase().includes(t))
  .sort((a,b)=>b.balance-a.balance).slice(0,50))});
app.post(A+'/give',adm,(q,s)=>{const u=db.users[clean(q.body.id)];if(!u)return s.status(404).json({error:'Topilmadi'});
  u.balance=Math.max(0,u.balance+Math.floor(+q.body.amount||0));save();s.json(u)});
app.get(A+'/promos',adm,(q,s)=>s.json(Object.entries(db.promos).map(([code,p])=>({code,amount:p.amount,left:p.left,used:p.used.length}))));
app.post(A+'/promos',adm,(q,s)=>{const c=clean(q.body.code).toUpperCase(),amount=Math.floor(+q.body.amount),uses=Math.floor(+q.body.uses);
  if(!c||!(amount>0)||!(uses>0))return s.status(400).json({error:'Maydonlar noto\'g\'ri'});
  db.promos[c]={amount,left:uses,used:[]};save();s.json({ok:1})});
app.delete(A+'/promos/:c',adm,(q,s)=>{delete db.promos[q.params.c];save();s.json({ok:1})});
app.get(A+'/contests',adm,(q,s)=>s.json(Object.values(db.contests)));
app.post(A+'/contests',adm,(q,s)=>{const id='c'+Date.now(),prize=Math.floor(+q.body.prize);
  if(!q.body.title||!(prize>0))return s.status(400).json({error:'Maydonlar noto\'g\'ri'});
  db.contests[id]={id,title:String(q.body.title).slice(0,60),prize,players:[],done:false};save();s.json({ok:1})});
app.post(A+'/contests/:id/draw',adm,(q,s)=>{const c=db.contests[q.params.id];
  if(!c||c.done||!c.players.length)return s.status(400).json({error:'Qatnashchi yo\'q yoki yopilgan'});
  const w=db.users[c.players[Math.floor(Math.random()*c.players.length)]];w.balance+=c.prize;c.done=true;c.winnerName=w.name;save();s.json(c)});
app.delete(A+'/contests/:id',adm,(q,s)=>{delete db.contests[q.params.id];save();s.json({ok:1})});

app.listen(process.env.PORT||3000,()=>console.log('epic_bot ishga tushdi'));
