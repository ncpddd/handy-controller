/* ════════════════════════════════════════════════════════
   HOLD MODE — press & hold to build up intensity, release to ease off.
   The longer the controller holds, the higher the HAMP velocity climbs;
   releasing makes it decay gradually back to rest.
════════════════════════════════════════════════════════ */

var HOLD_TICK_MS=140;        // cadence de la rampe + envoi vélocité
var HOLD_UP_PER_SEC=0.033;   // montée d'intensité par seconde maintenue (≈ 30s pour atteindre 100%)
var HOLD_DOWN_PER_SEC=0.20;  // décroissance par seconde après relâchement (≈ 5s pour revenir à 0)

/* ── State ── */
var holdActive=false;
var holdIsCtrl=false;
var holdHampRunning=false;
var holdLaunching=false;
var holdSpeed=0;             // 0..1, intensité courante
var holdHolding=false;      // le bouton est maintenu enfoncé
var holdTickTimer=null;
var holdLastVel=-1;         // dernière vélocité réellement envoyée (anti-spam)

/* ── Démarrage (contrôleur) ── */
function startHoldMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  basicActive=false;
  holdActive=true;holdIsCtrl=true;holdHampRunning=false;holdLaunching=false;
  holdSpeed=0;holdHolding=false;holdLastVel=-1;

  document.getElementById('holdOverlay').classList.add('active','is-ctrl');
  document.getElementById('holdHud').classList.add('show');
  holdBindOrb();
  holdRender();

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'hold_init'}));
  }
}

/* ── Démarrage côté passif (reçu via PeerJS) ── */
function holdPassiveStart(){
  holdActive=true;holdIsCtrl=false;
  holdSpeed=0;holdHampRunning=false;
  document.getElementById('holdOverlay').classList.add('active');
  document.getElementById('holdOverlay').classList.remove('is-ctrl');
  document.getElementById('holdHud').classList.remove('show');
  holdRender();
  document.getElementById('passiveSpeedHud').textContent='Speed: pause';
  document.getElementById('passiveSpeedHud').classList.add('show');
}

/* ── Mise à jour reçue (passif) : intensité de l'orbe ── */
function holdApplyUpdate(msg){
  if(!holdActive)return;
  holdSpeed=cl((msg.speedPct||0)/100,0,1);
  holdHampRunning=!!msg.running;
  holdRender();
}

/* ── Bouton à maintenir (contrôleur) ── */
function holdBindOrb(){
  var orb=document.getElementById('holdOrb');
  if(orb._bound)return;
  orb._bound=true;
  orb.addEventListener('mousedown',function(e){e.preventDefault();holdPress();});
  window.addEventListener('mouseup',function(){if(holdHolding)holdRelease();});
  orb.addEventListener('touchstart',function(e){e.preventDefault();holdPress();},{passive:false});
  orb.addEventListener('touchend',function(e){e.preventDefault();if(holdHolding)holdRelease();},{passive:false});
  orb.addEventListener('touchcancel',function(){if(holdHolding)holdRelease();});
}

function holdPress(){
  if(!holdIsCtrl)return;
  holdHolding=true;
  if(!holdHampRunning&&!holdLaunching)holdEnsureHamp();
  holdStartTimer();
}
function holdRelease(){
  if(!holdIsCtrl)return;
  holdHolding=false;
  holdStartTimer(); // garde la boucle active pour la décroissance
}

/* ── Boucle de rampe (contrôleur) ── */
function holdStartTimer(){
  if(holdTickTimer)return;
  holdTickTimer=setInterval(holdTick,HOLD_TICK_MS);
}
function holdStopTimer(){if(holdTickTimer){clearInterval(holdTickTimer);holdTickTimer=null;}}

function holdTick(){
  var dt=HOLD_TICK_MS/1000;
  if(holdHolding)holdSpeed=Math.min(1,holdSpeed+HOLD_UP_PER_SEC*dt);
  else holdSpeed=Math.max(0,holdSpeed-HOLD_DOWN_PER_SEC*dt);

  holdRender();
  holdBroadcast();
  if(holdHampRunning&&Math.abs(holdSpeed-holdLastVel)>=0.01){
    holdLastVel=holdSpeed;
    holdSetVelocity(holdSpeed);
  }
  // au repos (relâché et redescendu à 0) : on arrête la boucle ET on stoppe complètement
  // le Handy (HAMP off). Il sera relancé au prochain appui (convention "start paused").
  if(!holdHolding&&holdSpeed<=0){
    holdSpeed=0;holdStopTimer();holdLastVel=-1;
    if(holdHampRunning)holdStopHamp();
    holdRender();holdBroadcast();
  }
}

/* ── Rendu de l'orbe (ctrl + passif) ── */
function holdRender(){
  var pct=Math.round(holdSpeed*100);
  document.getElementById('holdOrbLabel').textContent=pct+'%';
  document.getElementById('holdFill').style.height=pct+'%';
  var orb=document.getElementById('holdOrb');
  orb.style.transform='scale('+(1+holdSpeed*0.22)+')';
  orb.style.boxShadow='0 0 '+(12+holdSpeed*70)+'px rgba(200,255,0,'+(0.25+holdSpeed*0.6).toFixed(3)+')';
  if(holdIsCtrl){
    document.getElementById('holdSpeedLabel').textContent=holdHampRunning?'Speed: '+pct+'%':'Speed: pause';
    document.getElementById('holdHint').textContent=holdHolding?'Building up… release to ease off':'Press and hold to build up';
  }
}

/* ── Sync partenaire ── */
function holdBroadcast(){
  if(!holdIsCtrl||!gameDataConn||!gameDataConn.open)return;
  var pct=Math.round(holdSpeed*100);
  gameDataConn.send(JSON.stringify({type:'hold_update',speedPct:pct,running:holdHampRunning}));
  gameDataConn.send(JSON.stringify({type:'speed_update',mode:'hold',speed:holdSpeed,running:holdHampRunning}));
}

/* ── HAMP (contrôleur uniquement) ── */
function holdHdrs(json){
  var h={'X-Connection-Key':ck,'Authorization':'Bearer '+token};
  if(json)h['Content-Type']='application/json';
  return h;
}
function holdSleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

async function holdEnsureHamp(){
  if(holdHampRunning||holdLaunching)return;
  holdLaunching=true;
  try{
    await fetch(V3+'/mode',{method:'PUT',headers:holdHdrs(true),body:JSON.stringify({mode:0})});
    await holdSleep(400);
    await fetch(V3+'/mode',{method:'PUT',headers:holdHdrs(true),body:JSON.stringify({mode:2})});
    await holdSleep(400);
    await fetch(V3+'/hamp/start',{method:'PUT',headers:holdHdrs(false)});
    await holdSleep(250);
    holdHampRunning=true;
    holdLastVel=holdSpeed;
    await holdSetVelocity(holdSpeed);
    holdRender();
  }catch(e){console.error('HOLD HAMP launch error:',e);}
  finally{holdLaunching=false;}
}

async function holdSetVelocity(v){
  if(!holdHampRunning)return;
  v=cl(v,0.05,1);
  try{await fetch(V3+'/hamp/velocity',{method:'PUT',headers:holdHdrs(true),body:JSON.stringify({velocity:v})});}
  catch(e){console.error('HOLD velocity error:',e);}
}

// Arrêt complet du Handy quand l'intensité retombe à 0 (relancé au prochain appui).
async function holdStopHamp(){
  if(!holdHampRunning)return;
  holdHampRunning=false;
  try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:holdHdrs(false)});}
  catch(e){console.error('HOLD hamp stop error:',e);}
}

/* ── Stop ── */
async function stopHoldMode(){
  holdActive=false;holdHolding=false;
  holdStopTimer();
  document.getElementById('holdOverlay').classList.remove('active','is-ctrl');
  document.getElementById('holdHud').classList.remove('show');
  document.getElementById('passiveSpeedHud').classList.remove('show');

  if(holdIsCtrl){
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'hold_stop'}));
    }
    if(holdHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:holdHdrs(false)});}catch(e){}
      holdHampRunning=false;
    }
    holdIsCtrl=false;
    document.getElementById('gameModeSelect').classList.add('active');
  }
}
