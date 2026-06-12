/* ════════════════════════════════════════════════════════
   GUITAR HERO MODE
════════════════════════════════════════════════════════ */

/* ── Config ── */
var GH_NOTE_SPEED_MIN   = 15;    // %hauteur/s vitesse défilement min
var GH_NOTE_SPEED_MAX   = 50;    // %hauteur/s vitesse défilement max
var GH_NOTE_SPEED_DECAY = 0.25;  // réduction par hit (%hauteur/s)
var GH_NOTE_SPEED_GROWTH= 1;     // augmentation par miss (%hauteur/s)
var GH_NOTE_SPAWN_Y     = -6;    // % position de spawn (au-dessus de l'écran)
var GH_SPEED_HIT        = -0.025;// -2.5% vitesse Handy par réussite
var GH_SPEED_MISS       = 0.025; // +2.5% vitesse Handy par raté
var GH_HIT_ZONE_Y_PCT   = 0.82;  // position zone de frappe (% hauteur écran)
var GH_COL_COOLDOWN_START = 1000; // délai mini de départ entre deux notes sur la même colonne
var GH_COL_COOLDOWN_DECAY = 100;  // réduction du délai à chaque raté
var GH_COL_COOLDOWN_MIN   = 100;  // délai mini plancher

/* ── State ── */
var ghActive      = false;
var ghIsCtrl      = false;  // true = on est le contrôleur dans ce mode
var ghSpeed       = 0.0;    // vitesse Handy courante 0..1
var ghStarted     = false;  // premier miss déclenche HAMP
var ghCombo       = 0;
var ghMiss        = 0;
var ghNoteSpeed   = GH_NOTE_SPEED_MIN; // %hauteur/s actuel
var ghNotes       = [];     // {id, col, el, spawnTime, y}
var ghNoteIdCtr   = 0;
var ghRafId       = null;
var ghLastFrame   = null;
var ghHampRunning = false;
var ghLastSentAt  = [0,0,0,0]; // dernier envoi par colonne (performance.now())
var ghColCooldown = GH_COL_COOLDOWN_START; // délai courant, réduit à chaque raté

/* ── Démarrage côté contrôleur ── */
async function startGuitarMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  basicActive=false;
  ghActive=true; ghIsCtrl=true;
  ghSpeed=0.0; ghCombo=0; ghMiss=0;
  ghNoteSpeed=GH_NOTE_SPEED_MIN;
  ghNotes=[]; ghHampRunning=false; ghStarted=false;
  ghLastSentAt=[0,0,0,0]; ghColCooldown=GH_COL_COOLDOWN_START;

  // Overlay visible pour les deux
  document.getElementById('ghOverlay').classList.add('active');
  // Pad contrôleur visible uniquement ici
  document.getElementById('ghCtrlPad').style.display='flex';
  // Colonnes passif non-cliquables côté ctrl
  for(var i=0;i<4;i++){
    var col=document.getElementById('ghCol'+i);
    col.style.pointerEvents='none';
  }

  ghUpdateHud();

  // Notifier le passif
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'gh_start'}));
  }

  // Démarrer le render loop
  ghLastFrame=performance.now();
  ghRafId=requestAnimationFrame(ghRenderLoop);
}

/* ── Démarrage côté passif (reçu via PeerJS) ── */
function ghPassiveStart(){
  ghActive=true; ghIsCtrl=false;
  ghSpeed=0.0; ghCombo=0; ghMiss=0;
  ghNoteSpeed=GH_NOTE_SPEED_MIN;
  ghNotes=[];

  document.getElementById('ghOverlay').classList.add('active');
  document.getElementById('ghCtrlPad').style.display='none';
  // Colonnes cliquables
  for(var i=0;i<4;i++){
    document.getElementById('ghCol'+i).style.pointerEvents='all';
  }

  ghUpdateHud();
  ghLastFrame=performance.now();
  ghRafId=requestAnimationFrame(ghRenderLoop);
}

/* ── Stop ── */
async function stopGuitarMode(){
  ghActive=false;
  if(ghRafId){cancelAnimationFrame(ghRafId);ghRafId=null;}
  // Nettoyer les notes
  ghNotes.forEach(function(n){if(n.el&&n.el.parentNode)n.el.parentNode.removeChild(n.el);});
  ghNotes=[];
  document.getElementById('ghOverlay').classList.remove('active');
  document.getElementById('ghCtrlPad').style.display='none';
  // Réactiver les colonnes
  for(var i=0;i<4;i++){
    document.getElementById('ghCol'+i).style.pointerEvents='all';
  }

  if(ghIsCtrl){
    // Notifier le passif
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'gh_stop'}));
    }
    // Stopper HAMP
    if(ghHampRunning){
      try{
        await fetch(V3+'/hamp/stop',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});
      }catch(e){}
      ghHampRunning=false;
    }
    document.getElementById('gameModeSelect').classList.add('active');
  }
}

/* ── Contrôleur envoie une note ── */
function ghCtrlSend(col){
  if(!ghActive||!ghIsCtrl)return;
  var now=performance.now();
  if(now-ghLastSentAt[col]<ghColCooldown)return;
  ghLastSentAt[col]=now;
  var id=ghNoteIdCtr++;
  var msg={type:'gh_note',id:id,col:col};
  // Spawn local (pour que le ctrl voie aussi la note)
  ghSpawnNote(id,col);
  // Envoyer au passif
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify(msg));
  }
  // Flash du bouton
  var btn=document.getElementById('ghCtrlPad').children[col];
  btn.style.background='rgba(255,255,255,0.25)';
  setTimeout(function(){btn.style.background='';},120);
}

/* ── Spawn d'une note (commun ctrl + passif) ── */
var GH_COL_COLORS=['#ff4d4d','#ffaa00','#4dff91','#4db8ff'];
function ghSpawnNote(id,col){
  var track=document.getElementById('ghTrack');
  var leftPct=(col/4*100)+(100/4/2);
  var color=GH_COL_COLORS[col]||'#ffffff';

  var el=document.createElement('div');
  el.className='gh-note';
  el.id='ghnote-'+id;
  el.style.top=GH_NOTE_SPAWN_Y+'%';
  el.style.left=leftPct+'%';
  el.style.transform='translateX(-50%)';
  el.style.background=color;
  el.style.boxShadow='0 0 14px '+color;
  track.appendChild(el);

  ghNotes.push({id:id,col:col,el:el,y:GH_NOTE_SPAWN_Y,hit:false,missed:false});
}

/* ── Render loop : défilement des notes ── */
function ghRenderLoop(now){
  if(!ghActive){return;}
  var dt=(now-(ghLastFrame||now))/1000;
  ghLastFrame=now;

  var hitY=GH_HIT_ZONE_Y_PCT*100;
  var toRemove=[];

  ghNotes.forEach(function(n){
    if(n.hit||n.missed)return;
    n.y+=ghNoteSpeed*dt;
    if(n.el) n.el.style.top=n.y+'%';

    // Sortie complète de l'écran sans tap → miss
    if(n.y>100){
      n.missed=true;
      toRemove.push(n);
      // Seulement côté passif le miss est comptabilisé
      if(!ghIsCtrl) ghOnMiss(n.col);
    }
  });

  // Retirer les notes hors écran
  toRemove.forEach(function(n){
    if(n.el&&n.el.parentNode)n.el.parentNode.removeChild(n.el);
    ghNotes=ghNotes.filter(function(x){return x.id!==n.id;});
  });

  ghRafId=requestAnimationFrame(ghRenderLoop);
}

/* ── Tap passif ── */
function ghPassiveTap(col,e){
  if(!ghActive||ghIsCtrl)return;
  if(e&&e.preventDefault)e.preventDefault();

  // Flash visuel colonne
  var colEl=document.getElementById('ghCol'+col);
  colEl.classList.add('gh-flash');
  setTimeout(function(){colEl.classList.remove('gh-flash');},120);

  var hitY=GH_HIT_ZONE_Y_PCT*100;

  // Chercher la note la plus proche de la ligne de frappe, dans la zone autorisée (hitY → bas de l'écran)
  var best=null,bestDist=Infinity;
  ghNotes.forEach(function(n){
    if(n.col!==col||n.hit||n.missed)return;
    if(n.y<hitY||n.y>100)return;
    var dist=Math.abs(n.y-hitY);
    if(dist<bestDist){best=n;bestDist=dist;}
  });

  if(best){
    // HIT
    best.hit=true;
    if(best.el&&best.el.parentNode)best.el.parentNode.removeChild(best.el);
    ghNotes=ghNotes.filter(function(x){return x.id!==best.id;});
    ghOnHit(col); // ghOnHit envoie lui-même le message gh_hit au contrôleur
  } else {
    // Tap dans le vide — pas de pénalité (évite les doubles pénalités)
  }
}

/* ── Résultats ── */
// Appelé côté passif uniquement
function ghOnHit(col){
  ghCombo++;
  ghSpeed=Math.max(0,Math.round((ghSpeed+GH_SPEED_HIT)*100)/100);
  ghNoteSpeed=Math.max(GH_NOTE_SPEED_MIN,ghNoteSpeed-GH_NOTE_SPEED_DECAY);
  ghUpdateHud();
  ghShowFeedback('NICE ×'+ghCombo,true);
  // Notifier le contrôleur → c'est lui qui applique la velocity HAMP
  if(camConn&&camConn.open){
    camConn.send(JSON.stringify({type:'gh_hit',col:col,speed:ghSpeed,noteSpeed:ghNoteSpeed}));
  }
}

function ghOnMiss(col){
  ghCombo=0; ghMiss++;
  ghSpeed=Math.min(1,Math.round((ghSpeed+GH_SPEED_MISS)*100)/100);
  ghNoteSpeed=Math.min(GH_NOTE_SPEED_MAX,ghNoteSpeed+GH_NOTE_SPEED_GROWTH);
  ghUpdateHud();
  ghShowFeedback('MISS',false);
  // Notifier le contrôleur → c'est lui qui applique la velocity HAMP
  if(camConn&&camConn.open){
    camConn.send(JSON.stringify({type:'gh_miss',col:col,speed:ghSpeed,noteSpeed:ghNoteSpeed}));
  }
}

// Appelé côté contrôleur uniquement quand il reçoit hit/miss
function ghCtrlApplyVelocity(speed, isFirstMiss, noteSpeed){
  ghSpeed=Math.round(speed*100)/100;
  if(noteSpeed) ghNoteSpeed=noteSpeed;
  ghUpdateHud();
  if(isFirstMiss&&!ghStarted){
    ghStarted=true;
    ghLaunchHamp();
  } else if(ghStarted){
    ghSetVelocity(ghSpeed);
  }
}

/* ── HAMP ── */
async function ghLaunchHamp(){
  try{
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:0})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/mode',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({mode:2})});
    await new Promise(function(r){setTimeout(r,400);});
    await fetch(V3+'/hamp/start',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});
    await new Promise(function(r){setTimeout(r,250);});
    ghHampRunning=true;
    ghUpdateHud();
    ghSetVelocity(ghSpeed);
  }catch(e){console.error('GH HAMP launch error:',e);}
}

async function ghSetVelocity(v){
  v=Math.round(v*100)/100;
  if(v<=0){
    if(ghHampRunning){
      try{await fetch(V3+'/hamp/stop',{method:'PUT',headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token}});}catch(e){}
      ghHampRunning=false;
      ghUpdateHud();
    }
    return;
  }
  if(!ghHampRunning){ghLaunchHamp();return;}
  v=Math.max(0.05,Math.min(1,v));
  try{
    await fetch(V3+'/hamp/velocity',{
      method:'PUT',
      headers:{'X-Connection-Key':ck,'Content-Type':'application/json','Authorization':'Bearer '+token},
      body:JSON.stringify({velocity:v})
    });
  }catch(e){console.error('GH velocity error:',e);}
}

/* ── UI ── */
function ghUpdateHud(){
  document.getElementById('ghSpeed').textContent=ghHampRunning
    ? 'Speed: '+Math.round(ghSpeed*100)+'%'
    : 'Speed: pause';
  document.getElementById('ghCombo').textContent='Combo: '+ghCombo;
  document.getElementById('ghMiss').textContent='Miss: '+ghMiss;
}

var ghFeedbackTimer=null;
function ghShowFeedback(text,hit){
  var el=document.getElementById('ghFeedback');
  el.textContent=text;
  el.className='gh-feedback show '+(hit?'hit':'miss');
  if(ghFeedbackTimer)clearTimeout(ghFeedbackTimer);
  ghFeedbackTimer=setTimeout(function(){el.classList.remove('show');},600);
}
