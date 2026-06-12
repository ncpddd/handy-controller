/* ════════════════════════════════════════════════════════
   GAME MODE — TARGET
════════════════════════════════════════════════════════ */

/* Config — toutes les variables du jeu */
var GAME_CYCLE_SPEED_MIN    = 0.0;   // vitesse de départ (0.0 - 1.0)
var GAME_CYCLE_SPEED_MAX    = 1.0;   // vitesse max
var GAME_SPEED_INCREMENT    = 0.05;  // +5% par raté
var GAME_CIRCLE_DURATION    = 5.0;  // secondes pour cliquer (départ)
var GAME_CIRCLE_DURATION_MIN= 0.5;   // minimum
var GAME_CIRCLE_DURATION_DECAY=0.1; // réduit par raté
var GAME_SPAWN_INTERVAL     = 1500;  // ms entre chaque cercle
var GAME_MAX_CIRCLES        = 15;    // max simultanés
var GAME_CIRCLE_SIZE        = 75;    // px diamètre

/* State */
var gameActive=false;
var gameSpeed=GAME_CYCLE_SPEED_MIN;
var gameHampRunning=false;  // le Handy démarre en pause, lancé au 1er événement (raté/touché)
var gameMissed=0;
var gameCircleDuration=GAME_CIRCLE_DURATION;
var gameCircles=[];         // {id, x%, y%, startTime, duration, el, svgEl, interval}
var gameSpawnTimer=null;
var gameCircleIdCounter=0;
var gameMode=false;         // true = on est en mode TARGET

/* ── BASIC MODE ── */
function startBasicMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='flex';
  document.getElementById('ctrlBottomBar').style.display='flex';
  basicActive=true;
  // Le canvas de contrôle est déjà initialisé
}

/* ── START / STOP GAME MODE (contrôleur) ── */
async function startGameMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';
  document.getElementById('gameHud').classList.add('active');

  basicActive=false;
  gameActive=true;gameMode=true;
  gameSpeed=GAME_CYCLE_SPEED_MIN;
  gameHampRunning=false;
  gameMissed=0;
  gameCircleDuration=GAME_CIRCLE_DURATION;
  gameCircles=[];
  updateGameHud();

  // Notifier le passif que le jeu TARGET commence
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'game_start'}));
  }

  // Le Handy démarre en pause, lancé au premier raté/touché (cf shellLaunchHamp)

  // Touch/click sur le canvas = spawner un cercle
  var c=document.getElementById('ctrlCanvas');
  c.addEventListener('click',onGameControllerClick);
  c.addEventListener('touchend',onGameControllerTouch,{passive:false});
}

/* ── HAMP ── */
async function gameLaunchHamp(){
  try{
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:0})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:2})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/hamp/start',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});
    await new Promise(function(r){setTimeout(r,250);});
    gameHampRunning=true;
    gameSetVelocity(gameSpeed);
  }catch(e){console.error('Game HAMP launch error:',e);}
}

async function gameSetVelocity(v){
  v=Math.round(v*100)/100;
  if(!gameHampRunning)return;
  if(v<=0){
    try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});}catch(e){}
    gameHampRunning=false;
    updateGameHud();
    return;
  }
  v=Math.max(0.05,Math.min(1,v));
  try{
    await fetch(V3+'/hamp/velocity',{
      method:'PUT',
      headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({velocity:v})
    });
  }catch(e){console.error('Game velocity error:',e);}
}

function onGameControllerClick(e){
  if(!gameActive||!gameMode)return;
  var xPct=Math.round((e.clientX/window.innerWidth)*100);
  var yPct=Math.round((e.clientY/window.innerHeight)*100);
  spawnCircleAt(xPct,yPct);
}
function onGameControllerTouch(e){
  if(!gameActive||!gameMode)return;
  e.preventDefault(); // évite le 'click' synthétique qui suit (double spawn)
  if(e.changedTouches.length===0)return;
  var t=e.changedTouches[0];
  var xPct=Math.round((t.clientX/window.innerWidth)*100);
  var yPct=Math.round((t.clientY/window.innerHeight)*100);
  spawnCircleAt(xPct,yPct);
}

function spawnCircleAt(xPct,yPct){
  if(gameCircles.length>=GAME_MAX_CIRCLES)return;

  var id=++gameCircleIdCounter;
  var duration=gameCircleDuration*1000;

  // Créer le cercle visuel côté contrôleur (simple indicateur)
  var el=document.createElement('div');
  el.className='ctrl-circle';
  el.style.cssText=[
    'width:'+GAME_CIRCLE_SIZE+'px',
    'height:'+GAME_CIRCLE_SIZE+'px',
    'left:'+(xPct)+'%',
    'top:'+(yPct)+'%',
    'border:2px solid rgba(200,255,0,0.4)',
    'background:rgba(200,255,0,0.05)',
    'pointer-events:none',
  ].join(';');
  document.getElementById('control-mode').appendChild(el);

  // Envoyer au passif via PeerJS
  console.log('gameDataConn:',gameDataConn?'exists':'null','open:',gameDataConn&&gameDataConn.open);
  if(gameDataConn&&gameDataConn.open){
    var msg=JSON.stringify({type:'circle_spawn',id:id,x:xPct,y:yPct,duration:duration});
    gameDataConn.send(msg);
    console.log('Sent circle to passive:',msg);
  } else {
    console.warn('No data connection to passive!');
  }

  var circle={id:id,x:xPct,y:yPct,startTime:Date.now(),duration:duration,el:el};
  gameCircles.push(circle);

  // Timer d'expiration
  circle.timeout=setTimeout(function(){
    onCircleMissed(id);
  },duration);

  // Retirer l'indicateur après la durée
  setTimeout(function(){
    if(el.parentNode)el.parentNode.removeChild(el);
  },duration+200);
}

function onCircleMissed(id){
  if(!gameActive)return;
  // Retirer le cercle
  gameCircles=gameCircles.filter(function(c){return c.id!==id;});
  gameMissed++;
  // Augmenter la vitesse
  gameSpeed=Math.min(GAME_CYCLE_SPEED_MAX,gameSpeed+GAME_SPEED_INCREMENT);
  // Réduire le temps
  gameCircleDuration=Math.max(GAME_CIRCLE_DURATION_MIN,gameCircleDuration-GAME_CIRCLE_DURATION_DECAY);
  updateGameHud();
  // Le Handy était en pause : le premier raté le lance
  if(!gameHampRunning) gameLaunchHamp();
  else gameSetVelocity(gameSpeed);
}

function onCircleHit(id){
  if(!gameActive)return;
  var circle=gameCircles.find(function(c){return c.id===id;});
  if(!circle)return;
  clearTimeout(circle.timeout);
  if(circle.el&&circle.el.parentNode)circle.el.parentNode.removeChild(circle.el);
  gameCircles=gameCircles.filter(function(c){return c.id!==id;});
  // Récompense : -3% vitesse (sans toucher au timer des cercles)
  gameSpeed=Math.round(Math.max(0,gameSpeed-0.03)*100)/100;
  updateGameHud();
  if(gameHampRunning) gameSetVelocity(gameSpeed);
  // Notifier le passif
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'circle_hit',id:id}));
  }
}

function updateGameHud(){
  document.getElementById('gameSpeed').textContent=gameHampRunning
    ? 'Speed: '+Math.round(gameSpeed*100)+'%'
    : 'Speed: pause';
  document.getElementById('gameMissed').textContent='Missed: '+gameMissed+' · Next: '+gameCircleDuration.toFixed(1)+'s';
}

async function stopGameMode(){
  gameActive=false;gameMode=false;
  gameCircles.forEach(function(c){
    clearTimeout(c.timeout);
    if(c.el&&c.el.parentNode)c.el.parentNode.removeChild(c.el);
  });
  gameCircles=[];
  var ctrlCanvas=document.getElementById('ctrlCanvas');
  ctrlCanvas.removeEventListener('click',onGameControllerClick);
  ctrlCanvas.removeEventListener('touchend',onGameControllerTouch);
  document.getElementById('gameHud').classList.remove('active');
  // Notifier le passif que le jeu est termine
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'game_stop'}));
  }
  // Stopper HAMP
  if(gameHampRunning){
    try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});}catch(e){}
    gameHampRunning=false;
  }
  // Retour au selecteur
  document.getElementById('gameModeSelect').classList.add('active');
}

/* ── PASSIVE SIDE : receive and display circles ── */
function initPassiveGame(){
  passiveMode=true;
  document.getElementById('passiveGameOverlay').classList.add('active');
}

function passiveSpawnCircle(id,xPct,yPct,duration){
  console.log('Spawning circle',id,'at',xPct+'%',yPct+'% for',duration,'ms');
  var size=GAME_CIRCLE_SIZE;
  var el=document.createElement('div');
  el.className='passive-circle';
  el.id='pcircle-'+id;
  el.style.cssText=[
    'width:'+size+'px',
    'height:'+size+'px',
    'left:'+xPct+'%',
    'top:'+yPct+'%',
  ].join(';');

  // SVG arc qui se vide
  var r=(size/2)-4;
  var circ=2*Math.PI*r;
  el.innerHTML=
    '<svg viewBox="0 0 '+size+' '+size+'" style="transform:rotate(-90deg)">'
    +'<circle cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'"'
    +' fill="none" stroke="rgba(200,255,0,0.25)" stroke-width="3"/>'
    +'<circle id="parc-'+id+'" cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'"'
    +' fill="none" stroke="#c8ff00" stroke-width="3"'
    +' stroke-dasharray="'+circ+'" stroke-dashoffset="0"'
    +' style="transition:stroke-dashoffset linear '+duration+'ms"/>'
    +'</svg>'
    +'<div class="passive-circle-inner"></div>';

  document.getElementById('passiveGameOverlay').appendChild(el);

  // Déclencher l'animation après un tick
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      var arc=document.getElementById('parc-'+id);
      if(arc)arc.style.strokeDashoffset=circ;
    });
  });

  // Click handler
  el.addEventListener('click',function(){
    passiveHitCircle(id);
  });
  el.addEventListener('touchstart',function(e){
    e.preventDefault();
    passiveHitCircle(id);
  },{passive:false});

  // Timeout côté passif
  setTimeout(function(){
    var existing=document.getElementById('pcircle-'+id);
    if(existing&&existing.parentNode)existing.parentNode.removeChild(existing);
  },duration+300);
}

function passiveHitCircle(id){
  var el=document.getElementById('pcircle-'+id);
  if(!el)return;
  // Flash vert puis disparaît
  el.style.background='rgba(200,255,0,0.3)';
  el.style.borderColor='#c8ff00';
  setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},200);
  // Notifier le contrôleur
  if(camConn&&camConn.open){
    camConn.send(JSON.stringify({type:'circle_hit',id:id}));
  }
}
