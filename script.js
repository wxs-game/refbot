const tg=window.Telegram&&Telegram.WebApp;
if(tg){tg.ready();tg.expand();try{tg.setHeaderColor('#07080c');tg.setBackgroundColor('#07080c');tg.disableVerticalSwipes&&tg.disableVerticalSwipes()}catch(e){}}
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const buzz=t=>{try{tg&&tg.HapticFeedback.impactOccurred(t||'light')}catch(e){}};
const CAT=[{n:'Jollychimp',e:'🐵',p:10.24,c:'#2f7d5b'},{n:'Love Candles',e:'🕯️',p:13.04,c:'#6b5f45'},{n:'Plush Bear',e:'🧸',p:25,c:'#7a4a32'},{n:'Diamond',e:'💎',p:60,c:'#2c5f86'},{n:'Rocket',e:'🚀',p:120,c:'#5a3a86'},{n:'Golden Crown',e:'👑',p:300,c:'#86701f'}];
const CASES=[{n:'Starter',e:'📦',cost:5,w:[50,30,15,5,0,0]},{n:'Gold',e:'🎁',cost:20,w:[10,25,35,22,7,1]},{n:'Elite',e:'🏆',cost:60,w:[0,5,20,40,28,7]}];
let S={bal:50,inv:[0],uid:0};
try{const s=JSON.parse(localStorage.getItem('upg'));if(s&&s.inv)S=s}catch(e){}
const save=()=>{try{localStorage.setItem('upg',JSON.stringify(S))}catch(e){}};
let own=S.inv.length?0:-1,tgt=1,spinning=false;
const m=n=>n.toFixed(2)+' $';
function toast(t,c){const e=$('#toast');e.textContent=t;e.className='on '+(c||'');clearTimeout(toast.t);toast.t=setTimeout(()=>e.className='',2200)}

/* ---- gauge ---- */
const pol=(r,a)=>{a=a*Math.PI/180;return[200+r*Math.sin(a),200-r*Math.cos(a)]};
function sector(r1,r2,a0,a1){const l=a1-a0>180?1:0,[x1,y1]=pol(r2,a0),[x2,y2]=pol(r2,a1),[x3,y3]=pol(r1,a1),[x4,y4]=pol(r1,a0);
 return `M${x1} ${y1}A${r2} ${r2} 0 ${l} 1 ${x2} ${y2}L${x3} ${y3}A${r1} ${r1} 0 ${l} 0 ${x4} ${y4}Z`}
(()=>{let h='';for(let i=0;i<72;i++){const long=i%6==0,[a,b]=pol(long?172:176,i*5),[c,d]=pol(long?190:184,i*5);h+=`<line x1="${a}" y1="${b}" x2="${c}" y2="${d}" stroke-width="${long?3:2}" opacity="${long?.7:.4}"/>`}$('#ticks').innerHTML=h})();
const calc=()=>{const o=CAT[S.inv[own]],t=CAT[tgt];if(!o)return{ch:0,x:0};const x=t.p/o.p;return{x,ch:Math.max(1,Math.min(95,100/x*.95))}};
let curAngle=0;
function draw(){const {ch,x}=calc(),w=ch*1.8;
 $('#arc').setAttribute('d',sector(108,148,180-w,180+w));$('#glow').setAttribute('d',sector(108,148,180-w,180+w));
 const [a,b]=pol(156,180-w),[c,d]=pol(156,180+w);$('#rim').setAttribute('d',`M${a} ${b}A156 156 0 ${w>90?1:0} 0 ${c} ${d}`);
 $('#pct').textContent=Math.round(ch)+'%';$('#mx').textContent='x'+x.toFixed(2);
 const o=CAT[S.inv[own]],t=CAT[tgt],set=(p,g,k)=>{$('#'+p+'e').textContent=g?g.e:'＋';$('#'+p+'e').style.background=g?g.c:'#222';$('#'+p+'n').textContent=g?g.n:'Выбери';$('#'+p+'p').textContent=g?m(g.p):'—'};
 set('o',o);set('t',t);
 $('#own').innerHTML=S.inv.length?S.inv.map((k,i)=>`<div class="chip ${i==own?'sel':''}" data-o="${i}"><span>${CAT[k].e}</span>${CAT[k].n}<br><i>${m(CAT[k].p)}</i></div>`).join(''):'<div style="color:var(--mu);font-size:13px">Пусто — открой кейс</div>';
 $('#tgt').innerHTML=CAT.map((g,i)=>`<div class="chip ${i==tgt?'sel':''}" data-t="${i}"><span>${g.e}</span>${g.n}<br><i>${m(g.p)}</i></div>`).join('');
 $('#go').disabled=spinning||!o||t.p<=o.p;
 $('#inv').innerHTML=S.inv.map((k,i)=>`<div class="chip" data-s="${i}"><span>${CAT[k].e}</span>${CAT[k].n}<br><i>${m(CAT[k].p)}</i></div>`).join('')||'<div style="color:var(--mu);grid-column:1/-1;text-align:center">Пока пусто</div>';
 $('#bal').textContent=m(S.bal);save()}
document.addEventListener('click',e=>{const c=e.target.closest('.chip');if(!c||spinning)return;
 if(c.dataset.o!=null)own=+c.dataset.o;
 if(c.dataset.t!=null)tgt=+c.dataset.t;
 if(c.dataset.s!=null){const i=+c.dataset.s;S.bal+=CAT[S.inv[i]].p;S.inv.splice(i,1);own=S.inv.length?0:-1;toast('Продано','win')}
 buzz();draw()});
$('#go').onclick=()=>{if(spinning)return;const {ch}=calc(),win=Math.random()*100<ch,w=ch*1.8,pad=Math.min(6,w*.2);
 const ang=win?180-w+pad+Math.random()*(2*w-2*pad):((180+w+pad+Math.random()*(360-2*w-2*pad))%360);
 const base=Math.ceil(curAngle/360)*360;curAngle=base+360*5+ang;spinning=true;draw();
 $('#ptr').style.transform=`rotate(${curAngle}deg)`;let n=0;const iv=setInterval(()=>{buzz('light');if(++n>22)clearInterval(iv)},180);
 setTimeout(()=>{spinning=false;const t=CAT[tgt];S.inv.splice(own,1);
  if(win){S.inv.push(tgt);toast('Победа! '+t.n,'win');buzz('heavy')}else{toast('Не повезло','lose');try{tg&&tg.HapticFeedback.notificationOccurred('error')}catch(e){}}
  own=S.inv.length?0:-1;draw()},4700)};

/* ---- cases ---- */
$('#cases').innerHTML=CASES.map((c,i)=>`<div class="card case"><div class="em">${c.e}</div><b>${c.n}</b><i style="font-style:normal;color:var(--gold);font-weight:800">${m(c.cost)}</i><button class="btn" data-c="${i}">Открыть</button></div>`).join('');
$('#cases').onclick=e=>{const b=e.target.closest('[data-c]');if(!b)return;const c=CASES[+b.dataset.c];
 if(S.bal<c.cost){toast('Не хватает баланса','lose');return}
 let r=Math.random()*100,i=0;for(;i<c.w.length-1;i++){if((r-=c.w[i])<0)break}
 while(!c.w[i])i--;S.bal-=c.cost;S.inv.push(i);if(own<0)own=0;buzz('medium');toast('Выпало: '+CAT[i].e+' '+CAT[i].n,'win');draw()};
$('#topup').onclick=()=>{S.bal+=25;draw();toast('+25 $','win')};
try{const u=tg&&tg.initDataUnsafe.user;if(u){$('#un').textContent=u.first_name;$('#av').textContent=u.first_name[0]}}catch(e){}

/* ---- liquid glass nav ---- */
const nav=$('#nav'),pill=$('#pill'),lens=$('#lens'),tabs=$$('.tab');
let cur=1,holding=false;
const geo=i=>{const r=tabs[i].getBoundingClientRect(),n=nav.getBoundingClientRect();return{l:r.left-n.left,w:r.width}};
function place(i,el,grow){const g=geo(i),w=g.w*(grow||1);el.style.left=(g.l-(w-g.w)/2)+'px';el.style.width=w+'px'}
function show(i){tabs.forEach((t,k)=>t.classList.toggle('on',k==i));$$('.page').forEach(p=>p.classList.toggle('on',p.id=='p-'+tabs[i].dataset.t))}
const nearest=x=>{const n=nav.getBoundingClientRect();let b=0,d=1e9;tabs.forEach((t,i)=>{const r=t.getBoundingClientRect(),dd=Math.abs(x-(r.left+r.width/2));if(dd<d){d=dd;b=i}});return b};
function move(x){const n=nav.getBoundingClientRect(),g=geo(0),w=g.w*1.12,c=Math.max(w/2-6,Math.min(n.width-w/2+6,x-n.left));lens.style.left=(c-w/2)+'px';lens.style.width=w+'px';
 const i=nearest(x);if(i!=hover){hover=i;buzz('light');tabs.forEach((t,k)=>t.classList.toggle('on',k==i))}}
let hover=1;
nav.addEventListener('pointerdown',e=>{holding=true;nav.setPointerCapture(e.pointerId);nav.classList.add('hold');lens.classList.add('drag');
 const i=nearest(e.clientX);place(cur,lens,1.12);lens.classList.add('on');requestAnimationFrame(()=>move(e.clientX));hover=-1;move(e.clientX);buzz('medium')});
nav.addEventListener('pointermove',e=>{if(holding)move(e.clientX)});
const up=e=>{if(!holding)return;holding=false;const i=nearest(e.clientX);lens.classList.remove('drag');place(i,lens,1.12);
 setTimeout(()=>{cur=i;place(i,pill);show(i);nav.classList.remove('hold');lens.classList.remove('on')},180);buzz('light')};
nav.addEventListener('pointerup',up);nav.addEventListener('pointercancel',up);
addEventListener('resize',()=>place(cur,pill));
place(cur,pill);draw();
