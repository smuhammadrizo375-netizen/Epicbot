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
  if(t)return{id:'tg'+t.id,name:t.first_name||t.username||'Player',tg:String(t.id),photo:t.photo_url||null};
  if(TOKEN&&process.env.ALLOW_GUEST==='0')return null;
  const id=clean(req.headers['x-uid']);return id&&!id.startsWith('tg')?{id,name:'Guest'}:null}
function me(req){const i=ident(req);if(!i)return null;
  if(!db.users[i.id]){db.users[i.id]={id:i.id,name:i.name,balance:START,created:Date.now(),games:0};save()}
  const u=db.users[i.id];if(i.tg&&u.name!==i.name){u.name=i.name;save()}u.tg=i.tg;if(i.photo)u.photo=i.photo;return u}
const auth=(q,s,n)=>{const u=me(q);if(!u)return s.status(401).json({error:'Kirish rad etildi'});q.u=u;n()};
const isAdm=q=>{const i=ident(q);return !!(i&&i.tg&&ADMIN_IDS.includes(i.tg))};
const adm=(q,s,n)=>(q.headers['x-admin']===ADMIN||isAdm(q))?n():s.status(403).json({error:'Ruxsat yo\'q'});
app.get('/api/is-admin',(q,s)=>s.json({admin:isAdm(q)}));
// ---------- MAJBURIY OBUNA ----------
db.channels=db.channels||[];db.pvpHist=db.pvpHist||[];
const subCache=new Map();
async function subStatus(u){const chs=db.channels||[];
  if(!TOKEN||!chs.length||!u.tg||ADMIN_IDS.includes(u.tg))return{ok:true,channels:[]};
  const c=subCache.get(u.id);if(c&&Date.now()-c.t<30000)return c.r;
  let ok=true;   // tekshiruv xatosi bo'lsa (bot kanalda admin emas) foydalanuvchini to'smaymiz
  for(const ch of chs){try{const r=await tgApi('getChatMember',{chat_id:ch.id,user_id:+u.tg});
    if(r.ok&&!['member','administrator','creator','restricted'].includes(r.result.status))ok=false}catch(e){console.error('obuna tekshiruvi:',e.message)}}
  const r={ok,channels:chs.map(c=>({id:c.id,title:c.title,url:'https://t.me/'+c.id.slice(1)}))};
  if(ok)subCache.set(u.id,{t:Date.now(),r});return r}
const needSub=async(q,s,n)=>{try{const r=await subStatus(q.u);if(r.ok)return n();s.status(403).json({error:'Avval kanallarga obuna bo\'ling',sub:true})}catch(e){n()}};
app.get('/api/sub',auth,async(q,s)=>s.json(await subStatus(q.u)));
// ---------- REFERAL ----------
db.refs=db.refs||{};db.settings=db.settings||{};if(db.settings.refReward==null)db.settings.refReward=5000;
let BOTNAME=process.env.BOT_USERNAME||'';
function regRef(m){const p=(m.text.split(' ')[1]||'');if(!p.startsWith('ref_')||!m.from)return;
  const r=p.slice(4).replace(/\D/g,''),me=String(m.from.id);
  if(r&&r!==me&&!db.refs[me]&&!db.users['tg'+me]){db.refs[me]=r;save()}}   // faqat yangi foydalanuvchi uchun
function refReward(u){u.refPaid=true;const rid=u.tg&&db.refs[u.tg],inv=rid&&db.users['tg'+rid];
  if(inv&&inv.id!==u.id){const v=db.settings.refReward;inv.balance+=v;inv.refCount=(inv.refCount||0)+1;inv.refEarned=(inv.refEarned||0)+v;db.stats.paid+=v}}
app.get('/api/ref',auth,(q,s)=>{const u=q.u;s.json({link:BOTNAME&&u.tg?`https://t.me/${BOTNAME}?start=ref_${u.tg}`:null,reward:db.settings.refReward,count:u.refCount||0,earned:u.refEarned||0})});
// Telegram bot (webhook)
const TGURL=process.env.WEBAPP_URL||process.env.RENDER_EXTERNAL_URL,WH=crypto.createHash('sha256').update(TOKEN).digest('hex').slice(0,32);
const tgApi=(m,b)=>fetch(`https://api.telegram.org/bot${TOKEN}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
if(TOKEN&&TGURL){
  tgApi('getMe',{}).then(r=>{if(r.ok&&!BOTNAME)BOTNAME=r.result.username}).catch(()=>{});
  const esc=x=>String(x||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  app.post('/tg/'+WH,(q,s)=>{s.sendStatus(200);const m=q.body.message;
    if(m&&m.text&&m.text.startsWith('/start'))regRef(m);
    if(m&&m.text&&m.text.startsWith('/start'))tgApi('sendMessage',{chat_id:m.chat.id,parse_mode:'HTML',
      text:`🌙 Assalomu alaykum <b>${esc(m.from&&m.from.first_name)}</b> ✨\n\n🚀 Botimizdan foydalanish uchun bosing 👇`,
      reply_markup:{inline_keyboard:[[{text:'🚀 O\'ynash',web_app:{url:TGURL}}]]}}).catch(()=>{})});
  tgApi('setWebhook',{url:TGURL+'/tg/'+WH}).then(r=>console.log('webhook',r.ok)).catch(console.error);
  tgApi('setMyCommands',{commands:[{command:'start',description:'O\'yinni boshlash'}]}).catch(()=>{});
  tgApi('setChatMenuButton',{menu_button:{type:'web_app',text:'O\'ynash',web_app:{url:TGURL}}}).catch(()=>{});
}

app.post('/api/me',auth,(q,s)=>{if(q.body.name&&!q.u.tg)q.u.name=String(q.body.name).slice(0,24);save();s.json(q.u)});
app.get('/api/history',(q,s)=>s.json(db.history.slice(-20).reverse()));
app.get('/api/top',(q,s)=>s.json(Object.values(db.users).sort((a,b)=>b.balance-a.balance).slice(0,20).map(u=>({name:u.name,balance:u.balance}))));

// ---------- UMUMIY RAUND ----------
const WAIT=7000,SHOW=3500,BOTS=['#7c5cff','#22c58b','#ff8a1f','#3b82f6','#ff5d73'];
let R,roundNo=0,botQ=[];
const pick=a=>a[Math.floor(Math.random()*a.length)];
function newRound(){R={id:++roundNo,state:'wait',end:Date.now()+WAIT,t0:0,crash:crashPoint(),bets:{}};
  botQ=BOTS.map((c,i)=>({at:Date.now()+600+Math.random()*(WAIT-2200),i})).filter(()=>Math.random()<0.85).sort((x,y)=>x.at-y.at)}
function botBet(i){const r=Math.random(),t=r<.6?1.1+Math.random()*1.4:r<.9?2.5+Math.random()*5.5:8+Math.random()*30;
  R.bets['bot'+i]={name:'Epic Bot',bot:true,color:BOTS[i],amount:pick([1000,2000,5000,10000,25000,50000]),cash:null,tgt:Math.round(t*100)/100}}
newRound();
setInterval(()=>{const n=Date.now();
  if(R.state==='wait'){while(botQ.length&&botQ[0].at<=n)botBet(botQ.shift().i);if(n>=R.end){R.state='run';R.t0=n}}
  if(R.state==='run'){const m=mult(R);
    for(const b of Object.values(R.bets))if(b.bot&&b.cash==null&&b.tgt<m&&b.tgt<R.crash)b.cash=b.tgt;
    if(m>=R.crash){R.state='crash';R.end=n+SHOW;db.history.push(R.crash);if(db.history.length>100)db.history.shift();save()}}
  else if(R.state==='crash'&&n>=R.end)newRound()},100);
// portlash qiymati raund tugamaguncha hech kimga yuborilmaydi
function view(q){const n=Date.now();
  const list=Object.entries(R.bets).map(([id,b])=>({name:b.name,photo:b.photo||null,bot:!!b.bot,color:b.color||null,amount:b.amount,cash:b.cash,
    win:b.cash?Math.floor(b.amount*b.cash):0,st:b.cash?'won':R.state==='crash'?'lost':'live',me:id===q.u.id})).sort((x,y)=>y.amount-x.amount);
  const mb=R.bets[q.u.id];
  return{id:R.id,state:R.state,wait:Math.max(0,R.end-n),elapsed:R.state==='run'?n-R.t0:0,crash:R.state==='crash'?R.crash:null,
    bets:list.slice(0,60),count:list.length,total:list.reduce((x,b)=>x+b.amount,0),balance:q.u.balance,
    history:db.history.slice(-20).reverse(),mine:mb?{amount:mb.amount,cash:mb.cash}:null}}
app.get('/api/round',auth,(q,s)=>s.json(view(q)));
app.post('/api/bet',auth,needSub,(q,s)=>{const u=q.u,a=Math.floor(+q.body.amount);
  if(R.state!=='wait')return s.status(400).json({error:'Raund ketmoqda, keyingisini kuting'});
  if(R.bets[u.id])return s.status(400).json({error:'Siz allaqachon stavka qilgansiz'});
  if(!(a>=MIN))return s.status(400).json({error:`Minimal stavka ${MIN}`});
  if(a>u.balance)return s.status(400).json({error:'Balans yetarli emas'});
  u.balance-=a;u.games++;db.stats.bets++;db.stats.wagered+=a;R.bets[u.id]={name:u.name,photo:u.photo,amount:a,cash:null};save();
  s.json({balance:u.balance})});
app.post('/api/cash',auth,(q,s)=>{const u=q.u,b=R.bets[u.id];
  if(R.state!=='run'||!b||b.cash)return s.status(400).json({error:'Hozir olib bo\'lmaydi'});
  const m=mult(R);if(m>=R.crash)return s.status(400).json({error:'Kech qoldingiz, raketa portladi'});
  b.cash=m;const win=Math.floor(b.amount*m);u.balance+=win;db.stats.paid+=win;save();s.json({balance:u.balance,m,win})});

app.post('/api/promo',auth,needSub,(q,s)=>{const p=db.promos[clean(q.body.code).toUpperCase()];
  if(!p||p.left<=0)return s.status(400).json({error:'Promokod yaroqsiz'});
  if(p.used.includes(q.u.id))return s.status(400).json({error:'Allaqachon ishlatilgan'});
  p.left--;p.used.push(q.u.id);q.u.balance+=p.amount;save();s.json({balance:q.u.balance,amount:p.amount})});
app.get('/api/contests',auth,(q,s)=>s.json(Object.values(db.contests).map(c=>({id:c.id,title:c.title,prize:c.prize,done:c.done,
  winner:c.winnerName,count:c.players.length,joined:c.players.includes(q.u.id)}))));
app.post('/api/contests/join',auth,needSub,(q,s)=>{const c=db.contests[q.body.id];
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
app.post('/api/tasks/claim',auth,needSub,(q,s)=>{const t=TASKS.find(x=>x.id===q.body.id),st=t&&taskState(q.u).find(x=>x.id===t.id);
  if(!st||st.status!=='ready')return s.status(400).json({error:'Vazifa hali bajarilmagan'});
  q.u.claimed[t.id]=Date.now();q.u.balance+=t.reward;save();s.json({balance:q.u.balance,reward:t.reward})});

// ---------- PVP (baraban: ko'k va qizil) ----------
const PVT={BET:7000,SPIN:7500,SHOW:5500},PBOTS=['#7c5cff','#22c58b'];
let P,pRound=0,pQ=[];
function newPvp(){P={id:++pRound,state:'bet',spinAt:0,end:0,point:null,winner:null,bets:{},blue:0,red:0};
  const f=Math.random()<.5?['blue','red']:['red','blue'],now=Date.now();
  pQ=PBOTS.map((c,i)=>({i,at:now+400+(i<2?Math.random()*1800:Math.random()*5500),side:i<2?f[i]:(Math.random()<.5?'blue':'red')})).sort((x,y)=>x.at-y.at)}
function pvpAdd(id,b){const x=P.bets[id];if(x)x.amount+=b.amount;else P.bets[id]=b;P[b.side]+=b.amount;
  if(!P.spinAt&&P.blue>0&&P.red>0)P.spinAt=Date.now()+PVT.BET}
newPvp();
setInterval(()=>{const n=Date.now();
  if(P.state==='bet'){
    while(pQ.length&&pQ[0].at<=n){const b=pQ.shift();pvpAdd('pb'+b.i,{name:'Epic Bot',bot:true,color:PBOTS[b.i],side:b.side,amount:pick([50,100,150,200])})}
    if(P.spinAt&&n>=P.spinAt){const tot=P.blue+P.red,pt=crypto.randomInt(0,1e9)/1e9*tot;   // g'olib shu paytda tasodifiy aniqlanadi
      P.point=pt/tot;P.winner=pt<P.blue?'blue':'red';P.state='spin';P.end=n+PVT.SPIN}}
  else if(P.state==='spin'&&n>=P.end){P.state='done';P.end=n+PVT.SHOW;const wt=P[P.winner],pot=P.blue+P.red;
    for(const [id,b] of Object.entries(P.bets)){if(b.side!==P.winner)continue;b.win=Math.floor(pot*b.amount/wt);
      if(!b.bot&&db.users[id]){db.users[id].balance+=b.win;db.stats.paid+=b.win}}
    db.pvpHist.push(P.winner);if(db.pvpHist.length>30)db.pvpHist.shift();save()}
  else if(P.state==='done'&&n>=P.end)newPvp()},100);
app.get('/api/pvp',auth,(q,s)=>{const n=Date.now(),mb=P.bets[q.u.id];
  const list=Object.entries(P.bets).map(([id,b])=>({name:b.name,photo:b.photo||null,bot:!!b.bot,color:b.color||null,side:b.side,amount:b.amount,win:b.win||0,me:id===q.u.id})).sort((x,y)=>y.amount-x.amount);
  s.json({id:P.id,state:P.state,blue:P.blue,red:P.red,left:P.state==='bet'?(P.spinAt?Math.max(0,P.spinAt-n):null):0,
    spinLeft:P.state==='spin'?Math.max(0,P.end-n):0,spinMs:PVT.SPIN,point:P.state==='bet'?null:P.point,winner:P.state==='done'?P.winner:null,
    bets:list.slice(0,80),count:list.length,balance:q.u.balance,mine:mb?{side:mb.side,amount:mb.amount}:null,hist:db.pvpHist.slice(-12).reverse()})});
app.post('/api/pvp/bet',auth,needSub,(q,s)=>{const u=q.u,a=Math.floor(+q.body.amount),side=q.body.side,x=P.bets[u.id];
  if(P.state!=='bet')return s.status(400).json({error:'Raund boshlandi, keyingisini kuting'});
  if(side!=='blue'&&side!=='red')return s.status(400).json({error:'Tomonni tanlang'});
  if(x&&x.side!==side)return s.status(400).json({error:'Siz boshqa tomonga stavka qilgansiz'});
  if(!(a>=MIN))return s.status(400).json({error:`Minimal stavka ${MIN}`});
  if(a>u.balance)return s.status(400).json({error:'Balans yetarli emas'});
  u.balance-=a;if(!x)u.games++;db.stats.bets++;db.stats.wagered+=a;pvpAdd(u.id,{name:u.name,photo:u.photo,side,amount:a});save();
  s.json({balance:u.balance})});

// ---------- UPGRADE ----------
// stavka -> maqsad: yutish ehtimoli = stavka / maqsad (maqsad qancha baland bo'lsa, foiz shuncha kam)
app.post('/api/upgrade',auth,needSub,(q,s)=>{const u=q.u,st=Math.floor(+q.body.stake),tg=Math.floor(+q.body.target);
  if(!(st>=MIN))return s.status(400).json({error:`Minimal stavka ${MIN}`});
  if(st>u.balance)return s.status(400).json({error:'Balans yetarli emas'});
  if(!(tg>=Math.ceil(st*1.05)&&tg<=st*100))return s.status(400).json({error:'Maqsad stavkadan 1.05 baravardan 100 baravargacha bo\'lishi kerak'});
  const ch=st/tg,win=crypto.randomInt(0,1e6)/1e6<ch,k=Math.random(),half=ch*180;
  // milya burchagi: yutuq yoyi pastki markazda (180°), yoy kengligi = ehtimol * 360°
  const ang=win?180+(k-.5)*2*half*.9:(180+half+k*(360-2*half))%360;
  u.balance-=st;u.games++;db.stats.bets++;db.stats.wagered+=st;if(win){u.balance+=tg;db.stats.paid+=tg}save();
  s.json({win,chance:ch,angle:(ang+360)%360,balance:u.balance,target:tg})});

// ---------- KEYSLAR ----------
const MULTS=[[0.1,20],[0.3,25],[0.6,20],[0.9,5],[1.2,14],[1.5,9],[3,5],[10,2]];   // 70% holatda narxdan kam tushadi
const PRICES=[500,1000,2500,5000,7500,8000,40000,60000,100000,150000,250000,500000];
const CNAMES=['Mini','Oddiy','Bronza','Kumush','Oltin','Rubin','Zumrad','Safir','Kristal','Titan','Legend','Imperator'];
const CASES=[{id:'free',name:'Kunlik bepul keys',emoji:'💎',price:0,items:[[100,50],[250,25],[500,15],[1000,8],[5000,2]]},
 ...PRICES.map((p,i)=>({id:'c'+p,name:CNAMES[i]+' keys',emoji:'💎',price:p,items:MULTS.map(([m,w])=>[Math.round(p*m),w])}))];
const DAY=24*3600e3;
app.get('/api/cases',auth,(q,s)=>s.json(CASES.map(c=>({id:c.id,name:c.name,emoji:c.emoji,price:c.price,items:c.items.map(([v,w])=>({v,w})),
  left:c.price?0:Math.max(0,(q.u.caseAt||0)+DAY-Date.now())}))));
app.post('/api/cases/open',auth,needSub,(q,s)=>{const c=CASES.find(x=>x.id===q.body.id),u=q.u;if(!c)return s.status(400).json({error:'Keys topilmadi'});
  if(!c.price){if(Date.now()<(u.caseAt||0)+DAY)return s.status(400).json({error:'Bepul keys hali tayyor emas'})}
  else if(u.balance<c.price)return s.status(400).json({error:'Balans yetarli emas'});
  let r=Math.random()*c.items.reduce((a,i)=>a+i[1],0),prize=c.items[0][0];
  for(const [v,w] of c.items){if((r-=w)<0){prize=v;break}}
  if(c.price)u.balance-=c.price;else{if(!u.refPaid)refReward(u);u.caseAt=Date.now()}u.balance+=prize;save();s.json({prize,balance:u.balance})});

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

// ---------- RESET (hammasini boshidan) ----------
app.post(A+'/reset',adm,(q,s)=>{for(const u of Object.values(db.users)){u.balance=START;u.games=0;u.claimed={}}
  db.stats={bets:0,wagered:0,paid:0};db.history=[];
  for(const k of Object.keys(R.bets))if(!R.bets[k].bot)delete R.bets[k];
  save();s.json({ok:1,users:Object.keys(db.users).length})});

// ---------- ADMIN: MAJBURIY OBUNA KANALLARI ----------
app.get(A+'/channels',adm,(q,s)=>s.json(db.channels));
app.post(A+'/channels',adm,async(q,s)=>{let id=String(q.body.channel||'').trim().replace(/^https?:\/\/t\.me\//,'').replace(/^@/,'');
  if(!/^[A-Za-z0-9_]{4,32}$/.test(id))return s.status(400).json({error:'Kanal username noto\'g\'ri (masalan @kanalim)'});id='@'+id;
  if(db.channels.some(c=>c.id.toLowerCase()===id.toLowerCase()))return s.status(400).json({error:'Bu kanal allaqachon qo\'shilgan'});
  if(!TOKEN)return s.status(400).json({error:'BOT_TOKEN sozlanmagan'});
  const c=await tgApi('getChat',{chat_id:id}).catch(()=>null),m=await tgApi('getMe',{}).catch(()=>null);
  if(!c||!c.ok||!m||!m.ok)return s.status(400).json({error:'Kanal topilmadi'});
  const t=await tgApi('getChatMember',{chat_id:id,user_id:m.result.id}).catch(()=>null);
  if(!t||!t.ok||!['administrator','creator'].includes(t.result.status))return s.status(400).json({error:'Avval botni kanalga admin qiling'});
  db.channels.push({id,title:c.result.title||id});subCache.clear();save();s.json({ok:1})});
app.delete(A+'/channels/:id',adm,(q,s)=>{db.channels=db.channels.filter(c=>c.id!=='@'+q.params.id);subCache.clear();save();s.json({ok:1})});

// ---------- ADMIN: SOZLAMALAR ----------
app.get(A+'/settings',adm,(q,s)=>s.json(db.settings));
app.post(A+'/settings',adm,(q,s)=>{const v=Math.floor(+q.body.refReward);if(!(v>=0&&v<=1e9))return s.status(400).json({error:'Noto\'g\'ri qiymat'});
  db.settings.refReward=v;save();s.json(db.settings)});

app.listen(process.env.PORT||3000,()=>console.log('epic_bot ishga tushdi'));
