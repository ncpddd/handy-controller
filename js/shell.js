/* ════════════════════════════════════════════════════════
   SHELL GAME MODE (bonneteau)
════════════════════════════════════════════════════════ */

/* ── Config ── */
var SHELL_SLOT_PCT=[20,50,80]; // position horizontale (%) des 3 emplacements
var SHELL_SWAP_DURATIONS=[900,700,500,350,250,180,130,95,70,50]; // ms par échange, index = niveau-1
var SHELL_SWAP_COUNT_MIN=4, SHELL_SWAP_COUNT_MAX=16, SHELL_SWAP_COUNT_DEFAULT=8;
var SHELL_SWAP_SPEED_MIN=1, SHELL_SWAP_SPEED_MAX=10, SHELL_SWAP_SPEED_DEFAULT=3;
var SHELL_REVEAL_HOLD=900;   // ms d'affichage de la balle avant le mélange
var SHELL_RESULT_HOLD=2000;  // ms d'affichage du résultat
var SHELL_SPEED_CORRECT=-0.03; // -3% en cas de bonne réponse
var SHELL_SPEED_WRONG=0.05;    // +5% en cas de mauvaise réponse

/* ── State ── */
var shellActive=false;
var shellIsCtrl=false;
var shellSwapCount=SHELL_SWAP_COUNT_DEFAULT;
var shellSwapSpeedLevel=SHELL_SWAP_SPEED_DEFAULT;
var shellSpeed=0.0;
var shellStarted=false;   // le Handy démarre en pause, lancé à la 1ère victoire
var shellHampRunning=false;
var shellRoundActive=false;
var shellGuessable=false;
var shellCupSlot=[0,1,2];   // cupId -> slot courant
var shellBallCup=0;         // id du gobelet sous lequel se trouve la balle

/* ── Démarrage (contrôleur) ── */
function startShellMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  basicActive=false;
  shellIsCtrl=true; shellActive=true;
  shellSpeed=0.0; shellStarted=false; shellHampRunning=false;
  shellRoundActive=false; shellGuessable=false;
  shellSwapCount=SHELL_SWAP_COUNT_DEFAULT; shellSwapSpeedLevel=SHELL_SWAP_SPEED_DEFAULT;

  document.getElementById('shellSwapCountVal').textContent=shellSwapCount;
  document.getElementById('shellSwapSpeedVal').textContent=shellSwapSpeedLevel;
  buildShellCups();
  document.getElementById('shellOverlay').classList.add('active');
  document.getElementById('shellHud').classList.add('show');
  document.getElementById('shellPlayBtn').textContent='▶ Play';
  document.getElementById('shellPlayBtn').disabled=false;
  shellUpdateHud();

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'shell_init'}));
  }
}

/* ── Démarrage côté passif (reçu via PeerJS) ── */
function shellPassiveStart(){
  shellActive=true; shellIsCtrl=false;
  shellRoundActive=false; shellGuessable=false;

  buildShellCups();
  document.getElementById('shellOverlay').classList.add('active');
  document.getElementById('shellHud').classList.remove('show');
  document.getElementById('shellHint').textContent='Waiting for controller…';
  document.getElementById('shellHint').classList.add('show');
}

/* ── Stop ── */
async function stopShellMode(){
  shellActive=false; shellRoundActive=false; shellGuessable=false;
  document.getElementById('shellOverlay').classList.remove('active');
  document.getElementById('shellHud').classList.remove('show');

  if(shellIsCtrl){
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'shell_stop'}));
    }
    if(shellHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});}catch(e){}
      shellHampRunning=false;
    }
    shellIsCtrl=false; shellStarted=false;
    document.getElementById('gameModeSelect').classList.add('active');
  }
}

/* ── Construction visuelle (commun) ── */
function buildShellCups(){
  shellCupSlot=[0,1,2];
  var area=document.getElementById('shellArea');
  area.classList.remove('hidden');
  area.innerHTML='';

  var ball=document.createElement('div');
  ball.className='shell-ball';
  ball.id='shellBall';
  ball.style.display='none';
  area.appendChild(ball);

  for(var i=0;i<3;i++){
    var cup=document.createElement('div');
    cup.className='shell-cup';
    cup.id='shellCup'+i;
    cup.style.left=SHELL_SLOT_PCT[shellCupSlot[i]]+'%';
    cup.addEventListener('click',function(){shellOnCupClick(this);});
    cup.addEventListener('touchend',function(e){e.preventDefault();shellOnCupClick(this);},{passive:false});
    area.appendChild(cup);
  }

  document.getElementById('shellResult').classList.remove('show','win','lose');
  document.getElementById('shellResult').textContent='';
}

/* ── Réglages (contrôleur) ── */
function shellAdjustSwapCount(delta){
  if(shellRoundActive)return;
  shellSwapCount=Math.max(SHELL_SWAP_COUNT_MIN,Math.min(SHELL_SWAP_COUNT_MAX,shellSwapCount+delta));
  document.getElementById('shellSwapCountVal').textContent=shellSwapCount;
}
function shellAdjustSwapSpeed(delta){
  if(shellRoundActive)return;
  shellSwapSpeedLevel=Math.max(SHELL_SWAP_SPEED_MIN,Math.min(SHELL_SWAP_SPEED_MAX,shellSwapSpeedLevel+delta));
  document.getElementById('shellSwapSpeedVal').textContent=shellSwapSpeedLevel;
}

/* ── Lancer une manche (contrôleur) ── */
function shellPlayRound(){
  if(!shellIsCtrl||!shellActive||shellRoundActive)return;
  document.getElementById('shellPlayBtn').disabled=true;

  var startBallCup=Math.floor(Math.random()*3);
  var swapDur=SHELL_SWAP_DURATIONS[shellSwapSpeedLevel-1];
  var seq=[];
  for(var i=0;i<shellSwapCount;i++){
    var a=Math.floor(Math.random()*3);
    var b=(a+1+Math.floor(Math.random()*2))%3;
    seq.push([a,b]);
  }

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'shell_round',startBallCup:startBallCup,seq:seq,swapDur:swapDur}));
  }
  shellRunRound(startBallCup,seq,swapDur);
}

/* ── Exécuter une manche (commun ctrl + passif) ── */
function shellRunRound(startBallCup,seq,swapDur){
  shellRoundActive=true; shellGuessable=false;
  shellBallCup=startBallCup;
  buildShellCups();
  document.getElementById('shellHint').classList.remove('show');
  document.getElementById('shellArea').style.setProperty('--swap-dur',(swapDur/1000)+'s');

  var ball=document.getElementById('shellBall');
  var startCupEl=document.getElementById('shellCup'+startBallCup);
  ball.style.left=startCupEl.style.left;
  ball.style.display='block';

  setTimeout(function(){
    startCupEl.classList.add('lifted');
    setTimeout(function(){
      startCupEl.classList.remove('lifted');
      setTimeout(function(){
        ball.style.display='none';
        shellRunSwaps(seq,0,swapDur);
      },300);
    },SHELL_REVEAL_HOLD);
  },200);
}

function shellRunSwaps(seq,idx,swapDur){
  if(idx>=seq.length){
    shellSwapsDone();
    return;
  }
  var pair=seq[idx];
  var a=pair[0],b=pair[1];
  var slotA=shellCupSlot[a],slotB=shellCupSlot[b];
  shellCupSlot[a]=slotB; shellCupSlot[b]=slotA;
  document.getElementById('shellCup'+a).style.left=SHELL_SLOT_PCT[slotB]+'%';
  document.getElementById('shellCup'+b).style.left=SHELL_SLOT_PCT[slotA]+'%';
  setTimeout(function(){shellRunSwaps(seq,idx+1,swapDur);},swapDur);
}

function shellSwapsDone(){
  shellGuessable=true;
  if(!shellIsCtrl){
    document.getElementById('shellHint').textContent='Tap the cup where you think the ball is';
    document.getElementById('shellHint').classList.add('show');
  }
}

/* ── Tap passif sur un gobelet ── */
function shellOnCupClick(cupEl){
  if(shellIsCtrl||!shellGuessable)return;
  shellGuessable=false;
  var cupId=parseInt(cupEl.id.replace('shellCup',''),10);
  var correct=(cupId===shellBallCup);
  document.getElementById('shellHint').classList.remove('show');
  shellRevealResult(cupId,correct);
  if(camConn&&camConn.open){
    camConn.send(JSON.stringify({type:'shell_guess',cupId:cupId,correct:correct}));
  }
}

/* ── Révélation (commun ctrl + passif) ── */
function shellRevealResult(cupId,correct){
  var ballCupEl=document.getElementById('shellCup'+shellBallCup);
  var ball=document.getElementById('shellBall');
  ball.style.left=ballCupEl.style.left;
  ball.style.display='block';
  ballCupEl.classList.add('lifted');

  var guessedCupEl=document.getElementById('shellCup'+cupId);
  guessedCupEl.classList.add(correct?'correct':'wrong');
  if(cupId!==shellBallCup) ballCupEl.classList.add('correct');

  var resultEl=document.getElementById('shellResult');
  resultEl.textContent=correct?'✅ Won!':'❌ Lost!';
  resultEl.className='show '+(correct?'win':'lose');

  setTimeout(function(){
    shellRoundActive=false;
    document.getElementById('shellArea').classList.add('hidden');
    document.getElementById('shellResult').classList.remove('show','win','lose');
    if(shellIsCtrl){
      document.getElementById('shellPlayBtn').disabled=false;
      document.getElementById('shellPlayBtn').textContent='🔁 Replay';
    } else {
      document.getElementById('shellHint').textContent='Waiting for controller…';
      document.getElementById('shellHint').classList.add('show');
    }
  },SHELL_RESULT_HOLD);
}

/* ── Application du résultat côté contrôleur (Handy) ── */
function shellApplyResult(cupId,correct){
  shellRevealResult(cupId,correct);

  if(correct){
    shellSpeed=Math.max(0,Math.round((shellSpeed-0.03)*100)/100);
  } else {
    shellSpeed=Math.min(1,Math.round((shellSpeed+0.05)*100)/100);
  }
  shellUpdateHud();

  if(correct&&!shellStarted){
    // Le Handy était en pause : la première victoire le lance
    shellStarted=true;
    shellLaunchHamp();
  } else if(shellStarted){
    shellSetVelocity(shellSpeed);
  }
  // Sinon (en pause, pas encore de victoire) : on accumule shellSpeed sans bouger le Handy
}

/* ── HAMP ── */
async function shellLaunchHamp(){
  try{
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:0})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:2})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/hamp/start',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});
    await new Promise(function(r){setTimeout(r,250);});
    shellHampRunning=true;
    shellUpdateHud();
    shellSetVelocity(shellSpeed);
  }catch(e){console.error('Shell HAMP launch error:',e);}
}

async function shellSetVelocity(v){
  v=Math.round(v*100)/100;
  if(v<=0){
    if(shellHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});}catch(e){}
      shellHampRunning=false;
      shellUpdateHud();
    }
    return;
  }
  if(!shellHampRunning){shellLaunchHamp();return;}
  v=Math.max(0.05,Math.min(1,v));
  try{
    await fetch(V3+'/hamp/velocity',{
      method:'PUT',
      headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({velocity:v})
    });
  }catch(e){console.error('Shell velocity error:',e);}
}

/* ── UI ── */
function shellUpdateHud(){
  document.getElementById('shellSpeedLabel').textContent=shellHampRunning
    ? 'Speed: '+Math.round(shellSpeed*100)+'%'
    : 'Speed: pause';
}
