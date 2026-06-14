/* ════════════════════════════════════════════════════════
   CONTROL DECK MODE — panneau de contrôle manuel en direct
════════════════════════════════════════════════════════ */

var cdActive=false;
var cdIsCtrl=false;
var cdHampRunning=false;
var cdLaunching=false;
var cdSpeed=0;            // 0..1
var cdRangeMin=0,cdRangeMax=100; // 0..100
var cdVelocityThrottle=null,cdPendingVelocity=null;
var cdRangeThrottle=null,cdPendingRange=null;
var cdMarkerRaf=null;
var CD_RANGE_GAP=5; // écart minimum entre les deux poignées du double-slider

/* ── Démarrage côté contrôleur ── */
function startControlDeckMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  basicActive=false;
  cdActive=true;cdIsCtrl=true;cdHampRunning=false;cdLaunching=false;
  cdSpeed=0;cdRangeMin=0;cdRangeMax=100;

  document.getElementById('cdSpeedSlider').value=0;
  document.getElementById('cdRangeMinSlider').value=0;
  document.getElementById('cdRangeMaxSlider').value=100;

  document.getElementById('cdOverlay').classList.add('active','is-ctrl');
  document.getElementById('cdHud').classList.add('show');
  cdUpdateSpeedFill();
  cdUpdateRangeFill();
  cdUpdateHud();
}

/* ── Démarrage côté passif (reçu via PeerJS) ── */
function cdPassiveStart(state){
  cdActive=true;cdIsCtrl=false;
  cdHampRunning=!!state.running;
  cdSpeed=(state.speedPct||0)/100;
  cdRangeMin=state.rangeMin!=null?state.rangeMin:0;
  cdRangeMax=state.rangeMax!=null?state.rangeMax:100;

  document.getElementById('cdOverlay').classList.add('active');
  document.getElementById('cdOverlay').classList.remove('is-ctrl');
  document.getElementById('cdHud').classList.remove('show');
  cdUpdateGaugeZone();
  document.getElementById('passiveSpeedHud').textContent=cdHampRunning
    ? 'Speed: '+Math.round(cdSpeed*100)+'%'
    : 'Speed: pause';
  document.getElementById('passiveSpeedHud').classList.add('show');
  cdStartMarkerLoop();
}

/* ── Mise à jour reçue (passif) ── */
function cdApplyUpdate(msg){
  if(!cdActive)return;
  cdSpeed=(msg.speedPct||0)/100;
  cdRangeMin=msg.rangeMin;cdRangeMax=msg.rangeMax;
  cdHampRunning=!!msg.running;
  cdUpdateGaugeZone();
}

/* ── Sliders (contrôleur) ── */
function cdOnSpeedInput(val){
  cdSpeed=cl(parseInt(val,10),0,100)/100;
  document.getElementById('cdSpeedValue').textContent=Math.round(cdSpeed*100)+'%';
  cdUpdateSpeedFill();
  if(!cdHampRunning&&!cdLaunching){cdEnsureHamp();}
  else{cdQueueVelocity(cdSpeed);}
  cdUpdateHud();
}

function cdOnRangeInput(which){
  var minSlider=document.getElementById('cdRangeMinSlider');
  var maxSlider=document.getElementById('cdRangeMaxSlider');
  var minVal=parseInt(minSlider.value,10);
  var maxVal=parseInt(maxSlider.value,10);
  if(which==='min'&&minVal>maxVal-CD_RANGE_GAP){minVal=Math.max(0,maxVal-CD_RANGE_GAP);minSlider.value=minVal;}
  if(which==='max'&&maxVal<minVal+CD_RANGE_GAP){maxVal=Math.min(100,minVal+CD_RANGE_GAP);maxSlider.value=maxVal;}
  cdRangeMin=minVal;cdRangeMax=maxVal;
  cdUpdateRangeFill();
  if(!cdHampRunning&&!cdLaunching){cdEnsureHamp();}
  else{cdQueueRange(cdRangeMin,cdRangeMax);}
  cdUpdateHud();
}

function cdUpdateSpeedFill(){
  document.getElementById('cdSpeedFill').style.width=(cdSpeed*100)+'%';
}
function cdUpdateRangeFill(){
  document.getElementById('cdRangeMinLabel').textContent='Min '+cdRangeMin+'%';
  document.getElementById('cdRangeMaxLabel').textContent='Max '+cdRangeMax+'%';
  var fill=document.getElementById('cdRangeFill');
  fill.style.bottom=cdRangeMin+'%';
  fill.style.height=(cdRangeMax-cdRangeMin)+'%';
}

/* ── Jauge (passif) ── */
function cdUpdateGaugeZone(){
  var zone=document.getElementById('cdGaugeZone');
  zone.style.bottom=cdRangeMin+'%';
  zone.style.height=(cdRangeMax-cdRangeMin)+'%';
}
function cdStartMarkerLoop(){
  var marker=document.getElementById('cdGaugeMarker');
  var start=performance.now();
  function tick(now){
    if(!cdActive)return;
    var freq=cdHampRunning?(0.15+cdSpeed*0.85):0; // cycles/sec, plus rapide si plus vite
    var phase=((now-start)/1000)*freq*Math.PI*2;
    var t=(Math.sin(phase)+1)/2; // 0..1
    var pos=cdRangeMin+(cdRangeMax-cdRangeMin)*t;
    marker.style.bottom=pos+'%';
    cdMarkerRaf=requestAnimationFrame(tick);
  }
  cdMarkerRaf=requestAnimationFrame(tick);
}
function cdStopMarkerLoop(){
  if(cdMarkerRaf){cancelAnimationFrame(cdMarkerRaf);cdMarkerRaf=null;}
}

/* ── HAMP helpers (contrôleur uniquement) ── */
function cdHdrs(json){
  var h={'X-Connection-Key':ck,'Authorization':'Bearer '+token};
  if(json)h['Content-Type']='application/json';
  return h;
}
function cdSleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

async function cdEnsureHamp(){
  if(cdHampRunning||cdLaunching)return;
  cdLaunching=true;
  try{
    await fetch(V3+'/mode',{method:'PUT',headers:cdHdrs(true),body:JSON.stringify({mode:0})});
    await cdSleep(400);
    await fetch(V3+'/mode',{method:'PUT',headers:cdHdrs(true),body:JSON.stringify({mode:2})});
    await cdSleep(400);
    await fetch(V3+'/hamp/start',{method:'PUT',headers:cdHdrs(false)});
    await cdSleep(250);
    cdHampRunning=true;
    await cdSetVelocity(cdSpeed);
    await cdSetRange(cdRangeMin,cdRangeMax);
    cdUpdateHud();
  }catch(e){console.error('CD HAMP launch error:',e);}
  finally{cdLaunching=false;}
}

function cdQueueVelocity(v){
  cdPendingVelocity=v;
  if(cdVelocityThrottle)return;
  cdVelocityThrottle=setTimeout(function(){
    cdVelocityThrottle=null;
    if(cdHampRunning)cdSetVelocity(cdPendingVelocity);
  },150);
}
function cdQueueRange(min,max){
  cdPendingRange={min:min,max:max};
  if(cdRangeThrottle)return;
  cdRangeThrottle=setTimeout(function(){
    cdRangeThrottle=null;
    cdSetRange(cdPendingRange.min,cdPendingRange.max);
  },150);
}

async function cdSetVelocity(v){
  if(!cdHampRunning)return;
  v=cl(v,0.05,1);
  try{await fetch(V3+'/hamp/velocity',{method:'PUT',headers:cdHdrs(true),body:JSON.stringify({velocity:v})});}
  catch(e){console.error('CD velocity error:',e);}
}
function cdSetRange(min,max){
  // plafond de hauteur passif : on met à l'échelle la plage de course
  fetch(V3+'/hamp/stroke',{method:'PUT',headers:cdHdrs(true),body:JSON.stringify({min:(min/100)*passiveMaxH,max:(max/100)*passiveMaxH})}).catch(function(){});
}

/* ── Start/Stop manuel (contrôleur) ── */
async function cdTogglePause(){
  if(cdLaunching)return;
  if(cdHampRunning){
    try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:cdHdrs(false)});}
    catch(e){console.error('CD stop error:',e);}
    cdHampRunning=false;
    cdUpdateHud();
  }else{
    await cdEnsureHamp();
  }
}
function cdUpdateToggleBtn(){
  document.getElementById('cdToggleBtn').textContent=cdHampRunning?'⏸ Pause':'▶ Start';
}

/* ── HUD + sync partenaire ── */
function cdUpdateHud(){
  document.getElementById('cdSpeedLabel').textContent=cdHampRunning
    ? 'Speed: '+Math.round(cdSpeed*100)+'%'
    : 'Speed: pause';
  cdUpdateToggleBtn();
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'cd_update',speedPct:Math.round(cdSpeed*100),rangeMin:cdRangeMin,rangeMax:cdRangeMax,running:cdHampRunning}));
    gameDataConn.send(JSON.stringify({type:'speed_update',mode:'cd',speed:cdSpeed,running:cdHampRunning}));
  }
}

/* ── Stop ── */
async function stopControlDeckMode(){
  cdActive=false;
  if(cdVelocityThrottle){clearTimeout(cdVelocityThrottle);cdVelocityThrottle=null;}
  if(cdRangeThrottle){clearTimeout(cdRangeThrottle);cdRangeThrottle=null;}
  cdStopMarkerLoop();
  document.getElementById('cdOverlay').classList.remove('active','is-ctrl');
  document.getElementById('cdHud').classList.remove('show');
  document.getElementById('passiveSpeedHud').classList.remove('show');

  if(cdIsCtrl){
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'cd_stop'}));
    }
    cdSetRange(0,100);
    if(cdHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:cdHdrs(false)});}catch(e){}
      cdHampRunning=false;
    }
    cdIsCtrl=false;
    document.getElementById('gameModeSelect').classList.add('active');
  }
}
