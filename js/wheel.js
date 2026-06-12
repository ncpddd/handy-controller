/* ════════════════════════════════════════════════════════
   WHEEL MODE — Roue de la fortune
════════════════════════════════════════════════════════ */

/* ── Config ── */
// 9 types de segments disponibles au setup ; la roue contient toujours 8 cases
var WHEEL_SEGMENT_TYPES=[
  {id:'pause5',   icon:'⏸',  label:'Pause 5s'},
  {id:'pause10',  icon:'⏸',  label:'Pause 10s'},
  {id:'plus5',    icon:'▲',  label:'+5%'},
  {id:'plus10',   icon:'▲',  label:'+10%'},
  {id:'minus5',   icon:'▼',  label:'-5%'},
  {id:'minus10',  icon:'▼',  label:'-10%'},
  {id:'maxspeed', icon:'🔥', label:'Max 3s'},
  {id:'slow10',   icon:'🐌', label:'Slow 10s'},
  {id:'pulse5',   icon:'〜', label:'Pulse 5s'},
  {id:'chaos8',   icon:'🌀', label:'Chaos 8s'},
  {id:'ballsdeep5', icon:'🍑', label:'Balls deep 5s'},
  {id:'tiponly5', icon:'👆', label:'Tip only 5s'},
  {id:'surprise', icon:'🎁', label:'Surprise'}
];
var WHEEL_COLORS=['#4db8ff','#2e8fd6','#4dff91','#1fcf6e','#ffaa00','#ff8800','#ff4d4d','#c8ff00','#ff66cc','#9966ff','#00d4ff','#ff9966','#cc66ff'];
var WHEEL_SPIN_DURATION=4000; // ms
var WHEEL_RESULT_HOLD  =1800; // ms

/* ── State ── */
var wheelActive=false;
var wheelIsCtrl=false;
var wheelConfig=[];        // 8 type-ids (fixé pour la session)
var wheelSetupPicks=[];    // sélection en cours pendant le setup
var wheelSpeed=0;          // vitesse "de base" 0..1
var wheelHampRunning=false;
var wheelSpinning=false;
var wheelRestoreTimer=null;
var wheelFlashTimer=null;
var wheelEffectTimer=null; // interval/timeout d'un effet périodique (pulse/chaos) en cours
var wheelSpinLock=false;  // true tant qu'un effet temporaire (max/slow/pause) bloque le SPIN
var wheelLastIndex=-1;     // évite (avec une faible probabilité de garder quand même) deux fois le même résultat de suite

/* ── Setup (contrôleur) ── */
function startWheelMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  basicActive=false;
  wheelIsCtrl=true;
  wheelSetupPicks=[];
  renderWheelSetup();
  document.getElementById('wheelSetup').classList.add('active');
}

function renderWheelSetup(){
  var grid=document.getElementById('wheelSetupGrid');
  grid.innerHTML='';
  WHEEL_SEGMENT_TYPES.forEach(function(t,i){
    var b=document.createElement('div');
    b.className='wheel-type-btn';
    b.style.setProperty('--seg-color',WHEEL_COLORS[i]);
    b.innerHTML='<div class="wt-icon">'+t.icon+'</div><div class="wt-label">'+t.label+'</div>';
    b.addEventListener('click',function(){
      if(wheelSetupPicks.length>=10)return;
      wheelSetupPicks.push(t.id);
      renderWheelSetupSlots();
    });
    grid.appendChild(b);
  });
  renderWheelSetupSlots();
}

function renderWheelSetupSlots(){
  var slots=document.getElementById('wheelSetupSlots');
  slots.innerHTML='';
  wheelSetupPicks.forEach(function(id,i){
    var idx=WHEEL_SEGMENT_TYPES.findIndex(function(t){return t.id===id;});
    var t=WHEEL_SEGMENT_TYPES[idx];
    var chip=document.createElement('div');
    chip.className='wheel-slot-chip';
    chip.style.setProperty('--seg-color',WHEEL_COLORS[idx]);
    chip.textContent=t.icon+' '+t.label+' ✕';
    chip.addEventListener('click',function(){
      wheelSetupPicks.splice(i,1);
      renderWheelSetupSlots();
    });
    slots.appendChild(chip);
  });
  document.getElementById('wheelSetupCount').textContent=wheelSetupPicks.length+' / 10';
  document.getElementById('wheelSetupStart').disabled=wheelSetupPicks.length<1;
  document.querySelectorAll('#wheelSetupGrid .wheel-type-btn').forEach(function(b){
    b.classList.toggle('disabled',wheelSetupPicks.length>=10);
  });
}

function wheelCancelSetup(){
  wheelIsCtrl=false;
  document.getElementById('wheelSetup').classList.remove('active');
  document.getElementById('gameModeSelect').classList.add('active');
}

function wheelConfirmSetup(){
  if(wheelSetupPicks.length<1||wheelSetupPicks.length>10)return;
  wheelConfig=wheelSetupPicks.slice();
  document.getElementById('wheelSetup').classList.remove('active');

  wheelActive=true;
  wheelSpeed=0;wheelHampRunning=false;wheelSpinning=false;wheelLastIndex=-1;
  buildWheelDisc(wheelConfig);
  document.getElementById('wheelOverlay').classList.add('active');
  document.getElementById('wheelHud').classList.add('show');
  document.getElementById('wheelSpinBtn').classList.add('show');
  wheelUpdateHud();

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'wheel_init',config:wheelConfig}));
  }
}

/* ── Démarrage côté passif (reçu via PeerJS) ── */
function wheelPassiveStart(config){
  wheelActive=true;wheelIsCtrl=false;wheelSpinning=false;
  wheelConfig=config;
  buildWheelDisc(wheelConfig);
  document.getElementById('wheelOverlay').classList.add('active');
  document.getElementById('wheelHud').classList.remove('show');
  document.getElementById('wheelSpinBtn').classList.remove('show');
  document.getElementById('passiveSpeedHud').textContent='Speed: pause';
  document.getElementById('passiveSpeedHud').classList.add('show');
}

/* ── Construction visuelle de la roue (commun ctrl + passif) ── */
function buildWheelDisc(config){
  var disc=document.getElementById('wheelDisc');
  disc.style.transition='none';
  disc.style.transform='rotate(0deg)';
  disc.innerHTML='';

  var n=config.length;
  var segAngle=360/n;
  var gradParts=[];
  config.forEach(function(typeId,i){
    var color=WHEEL_COLORS[i%WHEEL_COLORS.length]||'#888';
    gradParts.push(color+' '+(i*segAngle)+'deg '+((i+1)*segAngle)+'deg');
  });
  disc.style.background='conic-gradient(from 0deg,'+gradParts.join(',')+')';

  config.forEach(function(typeId,i){
    var t=WHEEL_SEGMENT_TYPES.find(function(x){return x.id===typeId;});
    var labelAngle=i*segAngle+segAngle/2;
    var rad=labelAngle*Math.PI/180;
    var r=32; // distance au centre, en % du rayon
    var x=50+r*Math.sin(rad);
    var y=50-r*Math.cos(rad);
    var label=document.createElement('div');
    label.className='wheel-seg-label';
    label.style.left=x+'%';
    label.style.top=y+'%';
    label.style.transform='translate(-50%,-50%) rotate('+(labelAngle+90)+'deg)';
    label.innerHTML=t.icon+'<br>'+t.label;
    disc.appendChild(label);
  });

  void disc.offsetWidth; // force reflow avant la prochaine transition
}

/* ── Spin (contrôleur décide du résultat, le passif rejoue la même animation) ── */
function wheelSpin(){
  if(!wheelIsCtrl||!wheelActive||wheelSpinning)return;

  var n=wheelConfig.length;
  var resultIndex=Math.floor(Math.random()*n);
  if(n>1&&resultIndex===wheelLastIndex&&Math.random()<0.7){
    resultIndex=Math.floor(Math.random()*n);
  }
  wheelLastIndex=resultIndex;
  var effectId=wheelResolveEffect(wheelConfig[resultIndex]);

  var segAngle=360/n;
  var targetAngle=resultIndex*segAngle+segAngle/2;
  var extraTurns=5+Math.floor(Math.random()*2); // 5-6 tours complets
  var rotation=extraTurns*360-targetAngle;

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'wheel_spin',resultIndex:resultIndex,rotation:rotation,effectId:effectId}));
  }

  wheelDoSpin(resultIndex,rotation,effectId);
}

function wheelResolveEffect(typeId){
  if(typeId!=='surprise')return typeId;
  var pool=WHEEL_SEGMENT_TYPES.filter(function(t){return t.id!=='surprise';});
  return pool[Math.floor(Math.random()*pool.length)].id;
}

function wheelDoSpin(resultIndex,rotation,effectId){
  wheelSpinning=true;
  var spinBtn=document.getElementById('wheelSpinBtn');
  if(spinBtn)spinBtn.disabled=true;

  var disc=document.getElementById('wheelDisc');
  var area=document.getElementById('wheelArea');
  var result=document.getElementById('wheelResult');

  result.classList.remove('show');result.textContent='';
  area.classList.add('show');

  disc.style.transition='none';
  disc.style.transform='rotate(0deg)';
  void disc.offsetWidth;
  disc.style.transition='transform '+(WHEEL_SPIN_DURATION/1000)+'s cubic-bezier(.12,.66,.18,1)';
  disc.style.transform='rotate('+rotation+'deg)';

  setTimeout(function(){
    var landed=WHEEL_SEGMENT_TYPES.find(function(t){return t.id===wheelConfig[resultIndex];});
    var applied=WHEEL_SEGMENT_TYPES.find(function(t){return t.id===effectId;});
    var text=landed.icon+' '+landed.label;
    if(effectId!==wheelConfig[resultIndex])text+=' → '+applied.icon+' '+applied.label;
    result.textContent=text;
    result.classList.add('show');

    if(wheelIsCtrl)wheelApplyEffect(effectId);

    setTimeout(function(){
      area.classList.remove('show');
      result.classList.remove('show');
      wheelSpinning=false;
      if(spinBtn)spinBtn.disabled=wheelSpinLock;
    },WHEEL_RESULT_HOLD);
  },WHEEL_SPIN_DURATION);
}

/* ── HAMP helpers (contrôleur uniquement) ── */
function wheelHdrs(json){
  var h={'X-Connection-Key':ck,'Authorization':'Bearer '+token};
  if(json)h['Content-Type']='application/json';
  return h;
}
function wheelSleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

async function wheelEnsureHamp(v){
  v=Math.round(v*100)/100;
  if(v<=0||wheelHampRunning){await wheelSetVelocity(v);return;}
  v=Math.max(0.05,Math.min(1,v));
  try{
    await fetch(V3+'/mode',{method:'PUT',headers:wheelHdrs(true),body:JSON.stringify({mode:0})});
    await wheelSleep(400);
    await fetch(V3+'/mode',{method:'PUT',headers:wheelHdrs(true),body:JSON.stringify({mode:2})});
    await wheelSleep(400);
    await fetch(V3+'/hamp/start',{method:'PUT',headers:wheelHdrs(false)});
    await wheelSleep(250);
    wheelHampRunning=true;
    wheelUpdateHud();
    await wheelSetVelocity(v);
  }catch(e){console.error('Wheel HAMP launch error:',e);}
}

async function wheelSetVelocity(v){
  v=Math.round(v*100)/100;
  if(v<=0){
    if(wheelHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:wheelHdrs(false)});}catch(e){}
      wheelHampRunning=false;
      wheelUpdateHud();
    }
    return;
  }
  if(!wheelHampRunning)return;
  v=Math.max(0.05,Math.min(1,v));
  try{
    await fetch(V3+'/hamp/velocity',{method:'PUT',headers:wheelHdrs(true),body:JSON.stringify({velocity:v})});
  }catch(e){console.error('Wheel velocity error:',e);}
}

/* ── Application de l'effet (contrôleur uniquement) ── */
function wheelApplyEffect(effectId){
  if(wheelRestoreTimer){clearTimeout(wheelRestoreTimer);wheelRestoreTimer=null;}
  wheelClearEffectTimer();
  switch(effectId){
    case 'plus5':    wheelAdjustSpeed(0.05);      break;
    case 'plus10':   wheelAdjustSpeed(0.10);      break;
    case 'minus5':   wheelAdjustSpeed(-0.05);     break;
    case 'minus10':  wheelAdjustSpeed(-0.10);     break;
    case 'maxspeed':
      wheelTempSpeed(1.0,3000);
      wheelFlashEdges('flash-red',3000);
      wheelLockSpin(3000);
      break;
    case 'slow10':
      wheelTempSpeed(0.05,10000);
      wheelFlashEdges('flash-yellow',10000);
      wheelLockSpin(10000);
      break;
    case 'pause5':
      wheelPause(5000);
      wheelFlashEdges('flash-green',5000);
      wheelLockSpin(5000);
      break;
    case 'pause10':
      wheelPause(10000);
      wheelFlashEdges('flash-green',10000);
      wheelLockSpin(10000);
      break;
    case 'pulse5':
      wheelPulse(5000);
      wheelFlashEdges('flash-pink',5000);
      wheelLockSpin(5000);
      break;
    case 'chaos8':
      wheelChaos(8000);
      wheelFlashEdges('flash-purple',8000);
      wheelLockSpin(8000);
      break;
    case 'ballsdeep5':
      wheelTempRange(0,30,5000);
      wheelFlashEdges('flash-blue',5000);
      wheelLockSpin(5000);
      break;
    case 'tiponly5':
      wheelTempRange(60,80,5000);
      wheelFlashEdges('flash-orange',5000);
      wheelLockSpin(5000);
      break;
  }
}

// Fait clignoter les bords de l'écran pendant durationMs
function wheelFlashEdges(colorClass,durationMs){
  var el=document.getElementById('wheelEdgeFlash');
  if(wheelFlashTimer){clearTimeout(wheelFlashTimer);}
  el.className=colorClass;
  wheelFlashTimer=setTimeout(function(){
    el.className='';
    wheelFlashTimer=null;
  },durationMs);
}

// Rend le bouton SPIN non-cliquable pendant durationMs
function wheelLockSpin(durationMs){
  wheelSpinLock=true;
  var spinBtn=document.getElementById('wheelSpinBtn');
  if(spinBtn)spinBtn.disabled=true;
  setTimeout(function(){
    wheelSpinLock=false;
    if(spinBtn&&!wheelSpinning)spinBtn.disabled=false;
  },durationMs);
}

// Annule l'effet périodique (pulse/chaos) en cours, s'il y en a un
function wheelClearEffectTimer(){
  if(wheelEffectTimer){clearInterval(wheelEffectTimer);clearTimeout(wheelEffectTimer);wheelEffectTimer=null;}
}

// Alterne entre deux vitesses toutes les 500ms pendant durationMs, puis revient à wheelSpeed
function wheelPulse(durationMs){
  var low=0.15,high=0.85,toggle=true;
  wheelEnsureHamp(high);
  wheelEffectTimer=setInterval(function(){
    toggle=!toggle;
    wheelSetVelocity(toggle?high:low);
  },500);
  wheelRestoreTimer=setTimeout(function(){
    wheelClearEffectTimer();
    wheelRestoreTimer=null;
    wheelSetVelocity(wheelSpeed);
  },durationMs);
}

// Vitesse aléatoire toutes les 0.8-1.5s pendant durationMs, puis revient à wheelSpeed
function wheelChaos(durationMs){
  function randomTick(){
    var v=Math.round((0.1+Math.random()*0.9)*100)/100;
    wheelEnsureHamp(v);
    wheelEffectTimer=setTimeout(randomTick,800+Math.random()*700);
  }
  randomTick();
  wheelRestoreTimer=setTimeout(function(){
    wheelClearEffectTimer();
    wheelRestoreTimer=null;
    wheelSetVelocity(wheelSpeed);
  },durationMs);
}

// Restreint l'amplitude de course du Handy à [min,max] (%) pendant durationMs, vitesse inchangée
function wheelSetRange(min,max){
  fetch(V3+'/hamp/stroke',{method:'PUT',headers:wheelHdrs(true),body:JSON.stringify({min:min/100,max:max/100})}).catch(function(){});
}
function wheelTempRange(min,max,durationMs){
  wheelSetRange(min,max);
  wheelRestoreTimer=setTimeout(function(){
    wheelRestoreTimer=null;
    wheelSetRange(0,100);
  },durationMs);
}

function wheelAdjustSpeed(delta){
  wheelSpeed=Math.max(0,Math.min(1,Math.round((wheelSpeed+delta)*100)/100));
  wheelEnsureHamp(wheelSpeed);
  wheelUpdateHud();
}

// Applique v pendant durationMs puis revient à wheelSpeed
function wheelTempSpeed(v,durationMs){
  wheelEnsureHamp(v);
  wheelRestoreTimer=setTimeout(function(){
    wheelRestoreTimer=null;
    wheelSetVelocity(wheelSpeed);
  },durationMs);
}

// Stoppe le HAMP pendant durationMs puis le relance à wheelSpeed
function wheelPause(durationMs){
  if(wheelHampRunning){
    fetch(V3+'/hamp/stop',{method:'PUT',headers:wheelHdrs(false)}).catch(function(){});
    wheelHampRunning=false;
    wheelUpdateHud();
  }
  wheelRestoreTimer=setTimeout(function(){
    wheelRestoreTimer=null;
    wheelEnsureHamp(wheelSpeed);
  },durationMs);
}

function wheelUpdateHud(){
  document.getElementById('wheelSpeedLabel').textContent=wheelHampRunning
    ? 'Speed: '+Math.round(wheelSpeed*100)+'%'
    : 'Speed: pause';
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'speed_update',mode:'wheel',speed:wheelSpeed,running:wheelHampRunning}));
  }
}

/* ── Stop ── */
async function stopWheelMode(){
  wheelActive=false;wheelSpinning=false;
  if(wheelRestoreTimer){clearTimeout(wheelRestoreTimer);wheelRestoreTimer=null;}
  if(wheelFlashTimer){clearTimeout(wheelFlashTimer);wheelFlashTimer=null;}
  wheelClearEffectTimer();
  wheelSpinLock=false;
  document.getElementById('wheelEdgeFlash').className='';
  document.getElementById('wheelOverlay').classList.remove('active');
  document.getElementById('wheelArea').classList.remove('show');
  document.getElementById('wheelResult').classList.remove('show');
  document.getElementById('wheelSetup').classList.remove('active');

  if(wheelIsCtrl){
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'wheel_stop'}));
    }
    wheelSetRange(0,100);
    if(wheelHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:wheelHdrs(false)});}catch(e){}
      wheelHampRunning=false;
    }
    wheelIsCtrl=false;
    document.getElementById('gameModeSelect').classList.add('active');
  }
}
