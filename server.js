const express=require('express'),fs=require('fs');
const app=express();app.use(express.json());app.use(express.static('public'));
const F=process.env.DB_PATH||'db.json',ADMIN=process.env.ADMIN_PASSWORD||'admin123';
let db={users:{},promos:{},contests:{},history:[],stats:{bets:0,wagered:0,paid:0}};
try{db=Object.assign(db,JSON.parse(fs.readFileSync(F)))}catch{}
let dirty=false;const save=()=>{dirty=true};
setInterval(()=>{if(dirty){dirty=false;fs.writeFile(F,JSON.stringify(db),()=>{})}},3000);
const MIN=1000,START=10000,RATE=0.1,games={};
const mult=g=>Math.floor(Math.exp(RATE*(Date.now()-g.t0)/1000)*100)/100;
function crashPoint(){const u=Math.random();return u>=0.6?1:Math.min(200,Math.max(1,Math.floor(0.6/u*100)/100))}
const clean=s=>String(s||'').replace(/[^\w\-]/g,'').slice(0,40);
function me(req){const id=clean(req.headers['x-uid']);if(!id)return null;if(!db.users[id]){db.users[id]={id,name:'Player',balance:START,created:Date.now(),games:0};save()}return db.users[id]}
const auth=(q,s,n)=>{const u=me(q);if(!u)return s.status(401).json({error:'uid'});q.u=u;n()};
const adm=(q,s,n)=>q.headers['x-admin']===ADMIN?n():s.status(403).json({error:'Parol xato'});
app.post('/api/me',auth,(q,s)=>{if(q.body.name)q.u.name=String(q.body.name).slice(0,24);save();s.json(q.u)});
app.get('/api/history',(q,s)=>s.json(db.history.slice(-20).reverse()));
app.get('/api/top',(q,s)=>s.json(Object.values(db.users).sort((a,b)=>b.balance-a.balance).slice(0,20).map(u=>({name:u.name,balance:u.balance}))));
app.post('/api/bet',auth,(q,s)=>{const u=q.u,a=Math.floor(+q.body.amount);if(games[u.id])return s.status(400).json({error:'O\'yin davom etmoqda'});if(!(a>=MIN))return s.status(400).json({error:`Minimal stavka ${MIN}`});if(a>u.balance)return s.status(400).json({error:'Balans yetarli emas'});u.balance-=a;u.games++;db.stats.bets++;db.stats.wagered+=a;games[u.id]={bet:a,t0:Date.now(),crash:crashPoint()};save();s.json({balance:u.balance})});
function finish(u,g,win){delete games[u.id];if(!win)db.history.push(g.crash);if(db.history.length>100)db.history.shift();save()}
app.get('/api/status',auth,(q,s)=>{const g=games[q.u.id];if(!g)return s.json({state:'idle'});const m=mult(g);if(m>=g.crash){finish(q.u,g,false);return s.json({state:'crashed',crash:g.crash})}s.json({state:'run',m,elapsed:Date.now()-g.t0})});
app.post('/api/cash',auth,(q,s)=>{const u=q.u,g=games[u.id];if(!g)return s.status(400).json({error:'O\'yin yo\'q'});const m=mult(g);if(m>=g.crash){finish(u,g,false);return s.json({state:'crashed',crash:g.crash})}const win=Math.floor(g.bet*m);u.balance+=win;db.stats.paid+=win;db.history.push(g.crash);finish(u,g,true);s.json({state:'won',m,win,balance:u.balance,crash:g.crash})});
app.post('/api/promo',auth,(q,s)=>{const p=db.promos[clean(q.body.code).toUpperCase()];if(!p||p.left<=0)return s.status(400).json({error:'Promokod yaroqsiz'});if(p.used.includes(q.u.id))return s.status(400).json({error:'Allaqachon ishlatilgan'});p.left--;p.used.push(q.u.id);q.u.balance+=p.amount;save();s.json({balance:q.u.balance,amount:p.amount})});
app.get('/api/contests',auth,(q,s)=>s.json(Object.values(db.contests).map(c=>({id:c.id,title:c.title,prize:c.prize,done:c.done,winner:c.winnerName,count:c.players.length,joined:c.players.includes(q.u.id)}))));
app.post('/api/contests/join',auth,(q,s)=>{const c=db.contests[q.body.id];if(!c||c.done)return s.status(400).json({error:'Konkurs yopilgan'});if(!c.players.includes(q.u.id))c.players.push(q.u.id);save();s.json({ok:1})});
const A='/api/admin';
app.get(A+'/stats',adm,(q,s)=>{const us=Object.values(db.users);s.json({users:us.length,balance:us.reduce((a,u)=>a+u.balance,0),active24h:0,...db.stats,promos:Object.keys(db.promos).length,contests:Object.keys(db.contests).length})});
app.get(A+'/users',adm,(q,s)=>{const t=String(q.query.q||'').toLowerCase();s.json(Object.values(db.users).filter(u=>!t||u.id.includes(t)||u.name.toLowerCase().includes(t)).sort((a,b)=>b.balance-a.balance).slice(0,50))});
app.post(A+'/give',adm,(q,s)=>{const u=db.users[clean(q.body.id)];if(!u)return s.status(404).json({error:'Topilmadi'});u.balance=Math.max(0,u.balance+Math.floor(+q.body.amount||0));save();s.json(u)});
app.get(A+'/promos',adm,(q,s)=>s.json(Object.entries(db.promos).map(([code,p])=>({code,amount:p.amount,left:p.left,used:p.used.length}))));
app.post(A+'/promos',adm,(q,s)=>{const c=clean(q.body.code).toUpperCase(),amount=Math.floor(+q.body.amount),uses=Math.floor(+q.body.uses);if(!c||!(amount>0)||!(uses>0))return s.status(400).json({error:'Maydonlar noto\'g\'ri'});db.promos[c]={amount,left:uses,used:[]};save();s.json({ok:1})});
app.delete(A+'/promos/:c',adm,(q,s)=>{delete db.promos[q.params.c];save();s.json({ok:1})});
app.get(A+'/contests',adm,(q,s)=>s.json(Object.values(db.contests)));
app.post(A+'/contests',adm,(q,s)=>{const id='c'+Date.now(),prize=Math.floor(+q.body.prize);if(!q.body.title||!(prize>0))return s.status(400).json({error:'Maydonlar noto\'g\'ri'});db.contests[id]={id,title:String(q.body.title).slice(0,60),prize,players:[],done:false};save();s.json({ok:1})});
app.post(A+'/contests/:id/draw',adm,(q,s)=>{const c=db.contests[q.params.id];if(!c||c.done||!c.players.length)return s.status(400).json({error:'Qatnashchi yo\'q yoki yopilgan'});const w=db.users[c.players[Math.floor(Math.random()*c.players.length)]];w.balance+=c.prize;c.done=true;c.winnerName=w.name;save();s.json(c)});
app.delete(A+'/contests/:id',adm,(q,s)=>{delete db.contests[q.params.id];save();s.json({ok:1})});
app.listen(process.env.PORT||3000,()=>console.log('epic_bot ishga tushdi'));
