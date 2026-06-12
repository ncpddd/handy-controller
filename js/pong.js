/* ════════════════════════════════════════════════════════
   RALLY — 1 vs MUR

   Terrain en portrait : la raquette est une barre
   HORIZONTALE en BAS de l'écran, le mur en HAUT, et la
   balle rebondit sur les bords GAUCHE et DROITE (x=0 / x=100).
════════════════════════════════════════════════════════ */
var RALLY_BALL_SPEED_LEVELS=[24,34,46,60,78,98,120,145]; // % terrain/seconde, index = niveau-1
var RALLY_BALL_SPEED_MIN=1, RALLY_BALL_SPEED_MAX=8, RALLY_BALL_SPEED_DEFAULT=3;
var RALLY_BALL_COUNT_MIN=1, RALLY_BALL_COUNT_MAX=6, RALLY_BALL_COUNT_DEFAULT=1;
var RALLY_PADDLE_SIZES=[28,20,13]; // % largeur du terrain, index = niveau-1 (1=grand/facile .. 3=petit/dur)
var RALLY_PADDLE_SIZE_MIN=1, RALLY_PADDLE_SIZE_MAX=3, RALLY_PADDLE_SIZE_DEFAULT=2;
var RALLY_BAR_THICKNESS_PX=6;   // hauteur CSS de .rally-wall / .rally-paddle
var RALLY_BALL_DIAMETER_PX=14;  // taille CSS de .rally-ball
var RALLY_SPEED_HIT=-0.02;  // tous les RALLY_HIT_STREAK_FOR_BONUS murs touchés : -2%
var RALLY_SPEED_MISS=0.03;  // laisser passer une balle : +3%
var RALLY_HIT_STREAK_FOR_BONUS=5; // nombre de murs touchés requis avant d'appliquer le bonus -2%

/* ── State ── */
var rallyActive=false;
var rallyIsCtrl=false;
var rallySpeed=0.0;
var rallyHampRunning=false; // le Handy démarre en pause, lancé au 1er événement
var rallyBallSpeedLevel=RALLY_BALL_SPEED_DEFAULT;
var rallyBallCount=RALLY_BALL_COUNT_DEFAULT;
var rallyPaddleSizeLevel=RALLY_PADDLE_SIZE_DEFAULT;
var rallyHits=0, rallyMisses=0;
var rallyHitStreak=0; // nombre de murs touchés depuis le dernier bonus -2%
var rallyPaddleX=50;  // % (centre de la raquette), passif uniquement
var rallyBalls=[];    // passif: {el,x,y,vx,vy} ; contrôleur: {el} (positions reçues)
var rallyRafId=null;
var rallyLastTs=null;
var rallyStateSendTs=0; // passif uniquement : throttle de l'envoi d'état au contrôleur
var rallyWallZone=4;    // % hauteur, recalculé par rallyComputeZones() pour matcher la taille visuelle
var rallyPaddleZone=4;  // % hauteur, idem

/* ── Démarrage (contrôleur) ── */
function startRallyMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  rallyIsCtrl=true; rallyActive=true;
  rallySpeed=0.0; rallyHampRunning=false;
  rallyHits=0; rallyMisses=0; rallyHitStreak=0;
  rallyBallSpeedLevel=RALLY_BALL_SPEED_DEFAULT;
  rallyBallCount=RALLY_BALL_COUNT_DEFAULT;
  rallyPaddleSizeLevel=RALLY_PADDLE_SIZE_DEFAULT;
  rallyPaddleX=50;

  document.getElementById('rallyBallCountVal').textContent=rallyBallCount;
  document.getElementById('rallySpeedVal').textContent=rallyBallSpeedLevel;
  document.getElementById('rallyPaddleVal').textContent=rallyPaddleSizeLevel;
  rallyUpdateHud();

  document.getElementById('rallyOverlay').classList.add('active');
  document.getElementById('rallyHud').classList.add('show');
  rallyBuildArea();

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'rally_init',ballCount:rallyBallCount,ballSpeedLevel:rallyBallSpeedLevel,paddleSizeLevel:rallyPaddleSizeLevel}));
  }
}

/* ── Réglages live (contrôleur) ── */
function rallyAdjustBallCount(delta){
  if(!rallyIsCtrl)return;
  rallyBallCount=Math.max(RALLY_BALL_COUNT_MIN,Math.min(RALLY_BALL_COUNT_MAX,rallyBallCount+delta));
  document.getElementById('rallyBallCountVal').textContent=rallyBallCount;
  rallySendConfig();
}
function rallyAdjustSpeed(delta){
  if(!rallyIsCtrl)return;
  rallyBallSpeedLevel=Math.max(RALLY_BALL_SPEED_MIN,Math.min(RALLY_BALL_SPEED_MAX,rallyBallSpeedLevel+delta));
  document.getElementById('rallySpeedVal').textContent=rallyBallSpeedLevel;
  rallySendConfig();
}
function rallyAdjustPaddleSize(delta){
  if(!rallyIsCtrl)return;
  rallyPaddleSizeLevel=Math.max(RALLY_PADDLE_SIZE_MIN,Math.min(RALLY_PADDLE_SIZE_MAX,rallyPaddleSizeLevel+delta));
  document.getElementById('rallyPaddleVal').textContent=rallyPaddleSizeLevel;
  rallyUpdatePaddleSize();
  rallySendConfig();
}
function rallySendConfig(){
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'rally_config',ballCount:rallyBallCount,ballSpeedLevel:rallyBallSpeedLevel,paddleSizeLevel:rallyPaddleSizeLevel}));
  }
}

/* ── Résultat reçu du passif (contrôleur) ── */
function rallyApplyResult(eventType){
  if(!rallyIsCtrl)return;
  if(eventType==='hit'){
    rallyHits++;
    rallyHitStreak++;
    if(rallyHitStreak>=RALLY_HIT_STREAK_FOR_BONUS){
      rallyHitStreak=0;
      rallySpeed=Math.max(0,Math.round((rallySpeed+RALLY_SPEED_HIT)*100)/100);
    }
  } else {
    rallyMisses++;
    rallySpeed=Math.min(1,Math.round((rallySpeed+RALLY_SPEED_MISS)*100)/100);
  }
  rallyUpdateHud();
  if(!rallyHampRunning) rallyLaunchHamp();
  else rallySetVelocity(rallySpeed);
}

/* ── HAMP (V3 uniquement) ── */
async function rallyLaunchHamp(){
  try{
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:0})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:2})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/hamp/start',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});
    await new Promise(function(r){setTimeout(r,250);});
    rallyHampRunning=true;
    rallySetVelocity(rallySpeed);
  }catch(e){console.error('Rally HAMP launch error:',e);}
}
async function rallySetVelocity(v){
  v=Math.max(0.05,Math.min(1,Math.round(v*100)/100));
  if(!rallyHampRunning)return;
  try{
    await fetch(V3+'/hamp/velocity',{
      method:'PUT',
      headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({velocity:v})
    });
  }catch(e){console.error('Rally velocity error:',e);}
}

/* ── HUD ── */
function rallyUpdateHud(){
  document.getElementById('rallySpeedLabel').textContent=rallyHampRunning
    ? 'Speed: '+Math.round(rallySpeed*100)+'%'
    : 'Speed: pause';
  document.getElementById('rallyHits').textContent='Wall: '+rallyHits;
  document.getElementById('rallyMisses').textContent='Misses: '+rallyMisses;
}

/* ── Stop (contrôleur) ── */
async function stopRallyMode(){
  rallyActive=false;
  if(rallyRafId){cancelAnimationFrame(rallyRafId);rallyRafId=null;}
  document.getElementById('rallyOverlay').classList.remove('active');
  document.getElementById('rallyHud').classList.remove('show');
  document.getElementById('rallyArea').innerHTML='';
  rallyBalls=[];

  if(rallyIsCtrl){
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'rally_stop'}));
    }
    if(rallyHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});}catch(e){}
      rallyHampRunning=false;
    }
    rallyIsCtrl=false;
    document.getElementById('gameModeSelect').classList.add('active');
  }
}

/* ── Démarrage côté passif (reçu via PeerJS) ── */
function rallyPassiveStart(config){
  rallyActive=true; rallyIsCtrl=false;
  rallyBallCount=config.ballCount;
  rallyBallSpeedLevel=config.ballSpeedLevel;
  rallyPaddleSizeLevel=config.paddleSizeLevel;
  rallyPaddleX=50;
  rallyHits=0; rallyMisses=0;

  document.getElementById('rallyOverlay').classList.add('active');
  document.getElementById('rallyHud').classList.remove('show');

  rallyBuildArea();
  rallyAttachControls();

  rallyLastTs=null;
  rallyRafId=requestAnimationFrame(rallyTick);
}

/* ── Reconfiguration live reçue du contrôleur (passif) ── */
function rallyApplyConfig(config){
  if(rallyIsCtrl||!rallyActive)return;
  rallyBallSpeedLevel=config.ballSpeedLevel;
  rallyPaddleSizeLevel=config.paddleSizeLevel;
  var newSpeed=RALLY_BALL_SPEED_LEVELS[rallyBallSpeedLevel-1];

  // Rééchelonner la vitesse des balles existantes en conservant leur direction
  rallyBalls.forEach(function(b){
    var mag=Math.sqrt(b.vx*b.vx+b.vy*b.vy);
    if(mag>0){
      var scale=newSpeed/mag;
      b.vx*=scale; b.vy*=scale;
    }
  });
  rallyUpdatePaddleSize();

  // Ajuster le nombre de balles
  var targetCount=config.ballCount;
  while(rallyBalls.length<targetCount) rallySpawnBall();
  while(rallyBalls.length>targetCount){
    var b=rallyBalls.pop();
    if(b.el&&b.el.parentNode)b.el.parentNode.removeChild(b.el);
  }
}

/* ── Construction visuelle (passif) ── */
function rallyBuildArea(){
  var area=document.getElementById('rallyArea');
  area.innerHTML='<div class="rally-wall" id="rallyWall"></div><div class="rally-paddle" id="rallyPaddle"></div>';
  rallyBalls=[];
  rallyComputeZones();
  rallyUpdatePaddleSize();
  document.getElementById('rallyPaddle').style.left=rallyPaddleX+'%';
  for(var i=0;i<rallyBallCount;i++) rallySpawnBall();
}
/* Recalcule la zone de collision (mur/raquette) en % pour qu'elle
   corresponde à la taille réelle (px) de la balle et des barres,
   quelle que soit la taille de l'écran. */
function rallyComputeZones(){
  var area=document.getElementById('rallyArea');
  var h=area.getBoundingClientRect().height||1;
  var pct=(RALLY_BAR_THICKNESS_PX+RALLY_BALL_DIAMETER_PX/2)/h*100;
  rallyWallZone=pct;
  rallyPaddleZone=pct;
}
function rallyUpdatePaddleSize(){
  var paddle=document.getElementById('rallyPaddle');
  if(paddle) paddle.style.width=RALLY_PADDLE_SIZES[rallyPaddleSizeLevel-1]+'%';
}
function rallySpawnBall(){
  var area=document.getElementById('rallyArea');
  var el=document.createElement('div');
  el.className='rally-ball';
  area.appendChild(el);
  var ball={el:el,x:0,y:0,vx:0,vy:0};
  rallyResetBall(ball);
  rallyBalls.push(ball);
}
function rallyResetBall(b){
  var speed=RALLY_BALL_SPEED_LEVELS[rallyBallSpeedLevel-1];
  var angle=(Math.random()*100-50)*Math.PI/180; // -50°..+50° autour de la verticale, vers la raquette (bas)
  b.x=10+Math.random()*80;
  b.y=rallyWallZone+5;
  b.vx=speed*Math.sin(angle);
  b.vy=speed*Math.cos(angle);
  rallyRenderBall(b);
}
function rallyRenderBall(b){
  b.el.style.left=b.x+'%';
  b.el.style.top=b.y+'%';
}

/* ── Boucle de jeu (passif) ── */
function rallyTick(ts){
  if(!rallyActive||rallyIsCtrl)return;
  if(rallyLastTs===null)rallyLastTs=ts;
  var dt=(ts-rallyLastTs)/1000;
  rallyLastTs=ts;
  if(dt>0.1)dt=0.1; // évite les sauts après un onglet en arrière-plan

  var paddleHalf=RALLY_PADDLE_SIZES[rallyPaddleSizeLevel-1]/2;

  rallyBalls.forEach(function(b){
    b.x+=b.vx*dt;
    b.y+=b.vy*dt;

    // Rebond gauche/droite
    if(b.x<=0){b.x=0;b.vx=Math.abs(b.vx);}
    else if(b.x>=100){b.x=100;b.vx=-Math.abs(b.vx);}

    // Mur (haut)
    if(b.y<=rallyWallZone&&b.vy<0){
      b.y=rallyWallZone;
      b.vy=Math.abs(b.vy);
      rallySendEvent('hit');
    }

    // Raquette (bas)
    if(b.y>=100-rallyPaddleZone&&b.vy>0){
      if(Math.abs(b.x-rallyPaddleX)<=paddleHalf){
        b.y=100-rallyPaddleZone;
        var offset=Math.max(-1,Math.min(1,(b.x-rallyPaddleX)/paddleHalf));
        var speed=Math.sqrt(b.vx*b.vx+b.vy*b.vy);
        b.vx=offset*speed*0.7;
        var vyMag=Math.sqrt(Math.max(speed*speed-b.vx*b.vx,speed*speed*0.25));
        b.vy=-vyMag;
      } else if(b.y>100){
        rallySendEvent('miss');
        rallyResetBall(b);
      }
    }

    rallyRenderBall(b);
  });

  var paddle=document.getElementById('rallyPaddle');
  if(paddle)paddle.style.left=rallyPaddleX+'%';

  // Diffuser l'état au contrôleur pour qu'il voie la partie en direct
  if(ts-rallyStateSendTs>=50){
    rallyStateSendTs=ts;
    if(camConn&&camConn.open){
      camConn.send(JSON.stringify({
        type:'rally_state',
        balls:rallyBalls.map(function(b){return{x:Math.round(b.x*10)/10,y:Math.round(b.y*10)/10};}),
        paddleX:Math.round(rallyPaddleX*10)/10
      }));
    }
  }

  rallyRafId=requestAnimationFrame(rallyTick);
}

/* ── État reçu du passif (contrôleur) : reflète la partie en direct ── */
function rallyApplyState(state){
  if(!rallyIsCtrl||!rallyActive)return;
  if(rallyBalls.length!==state.balls.length){
    rallyBallCount=state.balls.length;
    rallyBuildArea();
  }
  state.balls.forEach(function(b,i){
    if(rallyBalls[i]){
      rallyBalls[i].x=b.x; rallyBalls[i].y=b.y;
      rallyRenderBall(rallyBalls[i]);
    }
  });
  rallyPaddleX=state.paddleX;
  var paddle=document.getElementById('rallyPaddle');
  if(paddle)paddle.style.left=rallyPaddleX+'%';
}

function rallySendEvent(eventType){
  if(camConn&&camConn.open){
    camConn.send(JSON.stringify({type:'rally_event',event:eventType}));
  }
}

/* ── Contrôle de la raquette (passif) ── */
function rallyAttachControls(){
  var area=document.getElementById('rallyArea');
  function setPaddleFromClientX(clientX){
    var rect=area.getBoundingClientRect();
    var pct=((clientX-rect.left)/rect.width)*100;
    var half=RALLY_PADDLE_SIZES[rallyPaddleSizeLevel-1]/2;
    rallyPaddleX=Math.max(half,Math.min(100-half,pct));
  }
  area.addEventListener('touchstart',function(e){e.preventDefault();setPaddleFromClientX(e.touches[0].clientX);},{passive:false});
  area.addEventListener('touchmove',function(e){e.preventDefault();setPaddleFromClientX(e.touches[0].clientX);},{passive:false});
  area.addEventListener('mousedown',function(e){setPaddleFromClientX(e.clientX);});
  area.addEventListener('mousemove',function(e){if(e.buttons===1)setPaddleFromClientX(e.clientX);});
}

/* ── Stop reçu du contrôleur (passif) ── */
function rallyPassiveStop(){
  rallyActive=false;
  if(rallyRafId){cancelAnimationFrame(rallyRafId);rallyRafId=null;}
  document.getElementById('rallyOverlay').classList.remove('active');
  document.getElementById('rallyArea').innerHTML='';
  rallyBalls=[];
}

window.addEventListener('resize',function(){
  if(rallyActive&&!rallyIsCtrl) rallyComputeZones();
});
