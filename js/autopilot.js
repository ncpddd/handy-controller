/* ════════════════════════════════════════════════════════
   AUTO-PILOT MODE — presets de mouvement (position/hauteur) joués en boucle via HSSP
════════════════════════════════════════════════════════ */

/* ── Presets ── */
// curve(progress 0..1) → position 0..1 (0 = haut, 1 = bas — un cycle = un ou plusieurs va-et-vient)
var AUTOPILOT_PRESETS=[
  {id:'waves',    label:'Waves',      icon:'🌊', periodMs:1400,
    // va-et-vient complet, doux et régulier
    curve:function(p){return 0.5-0.45*Math.cos(p*2*Math.PI);}},
  {id:'deep',     label:'Deep',       icon:'🌀', periodMs:2200,
    // descente lente sur toute l'amplitude, remontée rapide
    curve:function(p){return p<0.7?(p/0.7):1-((p-0.7)/0.3);}},
  {id:'pulse',    label:'Pulse',      icon:'💓', periodMs:500,
    // petites pulsations rapides en surface
    curve:function(p){return 0.8+0.15*Math.sin(p*2*Math.PI);}},
  {id:'storm',    label:'Storm',      icon:'⚡', periodMs:1800,
    // va-et-vient erratique, plusieurs fréquences superposées
    curve:function(p){return cl(0.5+0.4*Math.sin(p*2*Math.PI)+0.15*Math.sin(p*2*Math.PI*5)+0.08*Math.sin(p*2*Math.PI*11),0,1);}},
  {id:'edging',   label:'Edging',     icon:'🔥', periodMs:20000,
    // immobile 5s, puis va-et-vient qui accélèrent et s'approfondissent jusqu'au reset
    curve:function(p){
      var t=p*20000,still=5000;
      if(t<still)return 0.5;
      var bt=(t-still)/1000,build=(20000-still)/1000; // secondes
      var f0=0.3,f1=2.1; // Hz, fréquence croissante (chirp), réglés pour boucler proprement
      var cycles=f0*bt+(f1-f0)*bt*bt/(2*build);
      var envelope=0.12+0.38*(bt/build);
      // sin (et non cos) pour partir de 0.5, raccord continu avec la phase immobile
      return 0.5-envelope*Math.sin(cycles*2*Math.PI);
    }},
  {id:'metronome',label:'Metronome',  icon:'🎵', periodMs:1000,
    // rythme constant, amplitude moyenne
    curve:function(p){var t=p<0.5?p*2:(1-p)*2;return 0.25+0.5*t;}}
];

/* ── State ── */
var apActive=false;
var apIsCtrl=false;
var apPlaying=false;
var apLaunching=false;
var apPresetId=null;
var apStartTime=0;
var apLabelTimer=null;

/* ── Setup (contrôleur) ── */
function startAutoPilotMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  basicActive=false;
  apActive=true;apIsCtrl=true;apPlaying=false;apLaunching=false;apPresetId=null;

  renderApPresetGrid();
  document.getElementById('apSetup').classList.add('active');
}

function apCancelSetup(){
  apActive=false;apIsCtrl=false;
  document.getElementById('apSetup').classList.remove('active');
  document.getElementById('gameModeSelect').classList.add('active');
}

function renderApPresetGrid(){
  var grid=document.getElementById('apPresetGrid');
  grid.innerHTML='';
  AUTOPILOT_PRESETS.forEach(function(preset){
    var card=document.createElement('div');
    card.className='ap-preset-card';
    var pts=apBuildWavePoints(preset.curve,160,100,30);
    card.innerHTML='<div class="ap-preset-icon">'+preset.icon+'</div>'+
      '<svg class="ap-preset-wave" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="'+pts+'"/></svg>'+
      '<div class="ap-preset-label">'+preset.label+'</div>';
    card.addEventListener('click',function(){apSelectPreset(preset.id);});
    grid.appendChild(card);
  });
}

function apBuildWavePoints(curve,steps,w,h){
  var pts=[];
  for(var i=0;i<=steps;i++){
    var p=i/steps;
    var v=cl(curve(p),0,1);
    var x=(i/steps)*w;
    var y=h-(v*h);
    pts.push(x.toFixed(1)+','+y.toFixed(1));
  }
  return pts.join(' ');
}

/* ── Application d'un preset (commun ctrl + passif) ── */
function apApplyPreset(presetId,startTime){
  apPresetId=presetId;apStartTime=startTime;
  var preset=AUTOPILOT_PRESETS.find(function(p){return p.id===presetId;});
  apDrawActiveWave(preset);
  if(apIsCtrl){
    apRenderPresetSwitcher();
  }
}

function apDrawActiveWave(preset){
  var pts=apBuildWavePoints(preset.curve,220,100,30);
  document.getElementById('apWavePath').setAttribute('points',pts);
  document.getElementById('apWaveLabel').textContent=preset.icon+' '+preset.label;
}

/* ── Sélection / changement de preset (contrôleur) ── */
async function apSelectPreset(id){
  if(!apIsCtrl||apLaunching)return;
  document.getElementById('apSetup').classList.remove('active');
  document.getElementById('apOverlay').classList.add('active','is-ctrl');
  document.getElementById('apHud').classList.add('show');

  var preset=AUTOPILOT_PRESETS.find(function(p){return p.id===id;});
  var playTime=await apStartPlayback(preset);
  apApplyPreset(id,playTime||Date.now());
  apStartLabelTimer();

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'ap_init',presetId:apPresetId,startTime:apStartTime}));
  }
}

async function apSwitchPreset(id){
  if(!apIsCtrl||id===apPresetId||apLaunching)return;
  var preset=AUTOPILOT_PRESETS.find(function(p){return p.id===id;});
  await apStopPlayback();
  var playTime=await apStartPlayback(preset);
  apApplyPreset(id,playTime||Date.now());

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'ap_init',presetId:apPresetId,startTime:apStartTime}));
  }
}

function apRenderPresetSwitcher(){
  var wrap=document.getElementById('apPresetSwitcher');
  wrap.innerHTML='';
  AUTOPILOT_PRESETS.forEach(function(preset){
    var btn=document.createElement('button');
    btn.className='ap-switch-btn'+(preset.id===apPresetId?' active':'');
    btn.textContent=preset.icon;
    btn.addEventListener('click',function(){apSwitchPreset(preset.id);});
    wrap.appendChild(btn);
  });
}

/* ── Démarrage côté passif (reçu via PeerJS) ── */
function apPassiveStart(msg){
  apActive=true;apIsCtrl=false;
  document.getElementById('apOverlay').classList.add('active');
  document.getElementById('apOverlay').classList.remove('is-ctrl');
  document.getElementById('apHud').classList.remove('show');
  apApplyPreset(msg.presetId,msg.startTime);
  document.getElementById('passiveSpeedHud').textContent='Position: pause';
  document.getElementById('passiveSpeedHud').classList.add('show');
}

/* ── HSSP helpers (contrôleur uniquement) ── */
function apHdrs(json){
  var h={'X-Connection-Key':ck,'Authorization':'Bearer '+token};
  if(json)h['Content-Type']='application/json';
  return h;
}
function apSleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

/* Construit un script CSV "temps_ms,position" à partir de la courbe du preset */
function apBuildCsv(preset){
  var steps=cl(Math.round(preset.periodMs/50),20,300);
  var lines=[];
  for(var i=0;i<=steps;i++){
    var p=i/steps;
    var t=Math.round(p*preset.periodMs);
    var pos=Math.round(cl(preset.curve(p),0,1)*100);
    lines.push(t+','+pos);
  }
  return lines.join('\n');
}

/* Héberge le script du preset (mis en cache sur le preset) */
async function apUploadScript(preset){
  if(preset.scriptUrl)return preset.scriptUrl;
  var csv=apBuildCsv(preset);
  var fd=new FormData();
  fd.append('file',new Blob([csv],{type:'text/csv'}),'preset.csv');
  var r=await fetch('https://www.handyfeeling.com/api/hosting/v2/upload',{method:'POST',body:fd});
  var d=await r.json();
  preset.scriptUrl=d.url;
  return d.url;
}

/* Charge et joue le script HSSP du preset (en boucle).
   Renvoie le timestamp réel envoyé comme server_time (= début effectif de la boucle). */
async function apStartPlayback(preset){
  if(apLaunching)return null;
  apLaunching=true;
  var playTime=null;
  try{
    var url=await apUploadScript(preset);
    await fetch(V3+'/hssp/setup',{method:'PUT',headers:apHdrs(true),body:JSON.stringify({url:url})});
    await apSleep(400);
    playTime=Date.now();
    await fetch(V3+'/hssp/play',{method:'PUT',headers:apHdrs(true),body:JSON.stringify({start_time:0,server_time:playTime,loop:true})});
    apPlaying=true;
  }catch(e){console.error('AP HSSP start error:',e);}
  finally{apLaunching=false;}
  return playTime;
}

async function apStopPlayback(){
  if(!apPlaying)return;
  try{await fetch(V3+'/hssp/stop',{method:'PUT',headers:apHdrs(false)});}
  catch(e){console.error('AP HSSP stop error:',e);}
  apPlaying=false;
}

/* ── HUD + sync partenaire ── */
function apStartLabelTimer(){
  if(apLabelTimer){clearInterval(apLabelTimer);apLabelTimer=null;}
  apUpdatePositionLabel();
  apLabelTimer=setInterval(apUpdatePositionLabel,300);
}
function apUpdatePositionLabel(){
  var preset=AUTOPILOT_PRESETS.find(function(p){return p.id===apPresetId;});
  if(!preset)return;
  var progress=((Date.now()-apStartTime)%preset.periodMs)/preset.periodMs;
  var pos=Math.round(cl(preset.curve(progress),0,1)*100);
  document.getElementById('apSpeedLabel').textContent=apPlaying
    ? 'Position: '+pos+'%'
    : 'Position: pause';
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'speed_update',mode:'ap',speed:pos/100,running:apPlaying}));
  }
}

/* ── Stop ── */
async function stopAutoPilotMode(){
  apActive=false;
  if(apLabelTimer){clearInterval(apLabelTimer);apLabelTimer=null;}
  document.getElementById('apOverlay').classList.remove('active','is-ctrl');
  document.getElementById('apHud').classList.remove('show');
  document.getElementById('apSetup').classList.remove('active');
  document.getElementById('passiveSpeedHud').classList.remove('show');

  if(apIsCtrl){
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'ap_stop'}));
    }
    await apStopPlayback();
    apIsCtrl=false;
    document.getElementById('gameModeSelect').classList.add('active');
  }
}
