/* ── CONFIG ── */
var V2='https://www.handyfeeling.com/api/handy/v2';
var V3='https://www.handyfeeling.com/api/handy-rest/v3';
var STROKE_MIN_DELTA=8,STROKE_DEADZONE=3;
var MIN_DUR_MS=80,MAX_DUR_MS=800;

/* ── STATE ── */
var ck='',ak='',token='',useV3=false;
var canvas,ctx,CH;
var drawing=false,lastY=null,lastT=null;
var curPos=50,curVel=0,sen=1.5;
var trail=[],TMAX=200;
var sendInterval=null;
var strokePoints=[],lastDir=0,strokeQueue=[],strokeRunning=false,lastCmdPos=50;

/* État partagé entre les modes de jeu */
var gameDataConn=null;      // connexion PeerJS données vers le passif
var passiveMode=false;      // true = on est le passif (mode TARGET)

/* ── API ── */
async function getToken(){
  var r=await fetch(V3+'/auth/token/issue?ttl=86400',{headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+ak}});
  if(!r.ok)throw new Error('Token request failed: '+r.status);
  var d=await r.json();
  if(d&&d.result&&d.result.token)return d.result.token;
  if(d&&d.token)return d.token;
  throw new Error('No token in response');
}

async function call(path,method,body){
  method=method||'GET';
  var url,headers={};
  if(useV3){
    url=V3+path;
    headers['Authorization']='Bearer '+token;
    headers['X-Connection-Key']=ck;
  }else{
    url=V2+path+'?connectionKey='+encodeURIComponent(ck);
    headers['X-Connection-Key']=ck;
  }
  if(body)headers['Content-Type']='application/json';
  var opts={method:method,headers:headers};
  if(body)opts.body=JSON.stringify(body);
  var r=await fetch(url,opts);
  if(!r.ok)throw new Error('HTTP '+r.status);
  return await r.json();
}

async function stopHandy(){
  try{if(useV3)await call('/hdsp/xpt','PUT',{xp:curPos});else await call('/hamp/stop','PUT');}catch(e){}
  var ms=document.getElementById('ms');if(ms)ms.textContent='idle';
}

/* ── CONTROL CANVAS ── */
function cl(v,a,b){return Math.max(a,Math.min(b,v));}
function yToPos(y,h){return Math.round(100-(cl(y,0,h)/h)*100);}

function startSendLoop(){
  if(sendInterval)return;
  sendInterval=setInterval(function(){if(drawing)sendCmd(curPos,curVel);},100);
}
function stopSendLoop(){if(sendInterval){clearInterval(sendInterval);sendInterval=null;}}

/* ── STROKE ENGINE ── */
function addStrokePoint(pos){
  if(!ck)return;
  var now=performance.now();
  strokePoints.push({pos:pos,t:now});
  if(strokePoints.length>20)strokePoints.shift();
  if(strokePoints.length<2)return;
  var prev=strokePoints[strokePoints.length-2];
  var cur=strokePoints[strokePoints.length-1];
  var delta=cur.pos-prev.pos;
  if(Math.abs(delta)<STROKE_DEADZONE)return;
  var newDir=delta>0?1:-1;
  if(lastDir!==0&&newDir!==lastDir){
    var peakPt=strokePoints[strokePoints.length-2];
    var startPt=findLastInversion();
    if(startPt){
      var sd=Math.abs(peakPt.pos-startPt.pos);
      if(sd>=STROKE_MIN_DELTA){
        var dur=Math.max(MIN_DUR_MS,Math.min(MAX_DUR_MS,Math.round(peakPt.t-startPt.t)));
        enqueueStroke(peakPt.pos,dur);
      }
    }
  }
  lastDir=newDir;
}

function findLastInversion(){
  for(var i=strokePoints.length-3;i>=0;i--){
    var d=strokePoints[i+1].pos-strokePoints[i].pos;
    if(Math.abs(d)>=STROKE_DEADZONE){var dir=d>0?1:-1;if(dir!==lastDir)return strokePoints[i];}
  }
  return strokePoints[0]||null;
}

function enqueueStroke(pos,dur){strokeQueue.push({pos:pos,dur:dur});if(!strokeRunning)runStrokeQueue();}

async function runStrokeQueue(){
  if(strokeRunning)return;strokeRunning=true;
  while(strokeQueue.length>0){
    var stroke=strokeQueue.shift();
    var started=performance.now();
    try{
      var url=V2+'/hdsp/xpt';
      fetch(url,{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json'},
        body:JSON.stringify({stopOnTarget:true,immediateResponse:true,duration:stroke.dur,position:(100-stroke.pos)/100})});
    }catch(e){}
    var elapsed=performance.now()-started;
    await new Promise(function(r){setTimeout(r,Math.max(20,stroke.dur-elapsed+20));});
  }
  strokeRunning=false;
}

async function sendCmd(pos,vel){if(!ck)return;addStrokePoint(pos);}

/* ── RENDER CONTROL CANVAS ── */
function velToRGB(vel){
  if(useV3){if(vel>180)return[255,77,77];if(vel>80)return[255,140,58];return[77,159,255];}
  else{if(vel>70)return[255,77,77];if(vel>35)return[255,140,58];return[77,159,255];}
}

/* ════════════════════════════════════════════════════════
   CAMERA MODE
════════════════════════════════════════════════════════ */
var camPeer=null,camConn=null,camRoomCode='';

function generateRoomCode(){
  var chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code='';
  for(var i=0;i<3;i++)code+=chars[Math.floor(Math.random()*chars.length)];
  code+='-';
  for(var i=0;i<3;i++)code+=chars[Math.floor(Math.random()*chars.length)];
  return code;
}

async function initCameraMode(){
  document.getElementById('camera-mode').classList.add('active');

  // Start camera
  try{
    var stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});
    document.getElementById('camVideo').srcObject=stream;
  }catch(e){
    document.getElementById('camStatus').textContent='Camera error: '+e.message;
    return;
  }

  // Generate room code and create peer
  var roomCode=generateRoomCode();
  camRoomCode=roomCode;
  document.getElementById('camRoomCode').textContent=roomCode;
  document.getElementById('camStatus').textContent='Waiting for controller...';

  // PeerJS: use room code as peer ID (normalized)
  var peerId='handyctrl-'+roomCode.replace('-','');
  camPeer=new Peer(peerId);

  camPeer.on('open',function(id){
    console.log('Camera peer ready:',id);
  });

  camPeer.on('call',function(call){
    // Answer with our camera stream
    var stream=document.getElementById('camVideo').srcObject;
    call.answer(stream);
    // Hide overlay, show connected dot
    document.getElementById('camOverlay').style.display='none';
    document.getElementById('camConnectedDot').classList.add('show');
    document.getElementById('camLabel').classList.add('show');
  });

  camPeer.on('connection',function(conn){
    camConn=conn;
    console.log('Passive: controller connected via data channel');
    // Activer l'overlay passif dès que le contrôleur se connecte
    // Ne pas activer le jeu tout de suite — attendre le message game_start
    conn.on('open',function(){
      console.log('Passive: data channel open');
    });
    conn.on('data',function(data){
      console.log('Passive received data:',data);
      handlePeerData(data);
    });
    conn.on('close',function(){
      console.warn('Passive: data channel closed');
      camConn=null;
      resetAllGames();
    });
  });

  camPeer.on('error',function(e){
    document.getElementById('camStatus').textContent='Error: '+e.message;
  });
}

function camToggleLinkForm(){
  var form=document.getElementById('camLinkForm');
  form.classList.toggle('active');
  if(form.classList.contains('active')){
    document.getElementById('camCkInput').value=localStorage.getItem('handy_ck')||'';
    document.getElementById('camAkInput').value=localStorage.getItem('handy_ak')||'';
  }
}

async function camGenerateLink(){
  var ckVal=document.getElementById('camCkInput').value.trim();
  var akVal=document.getElementById('camAkInput').value.trim();
  if(!ckVal){alert('Please enter your Connection Key');return;}
  localStorage.setItem('handy_ck',ckVal);
  if(akVal)localStorage.setItem('handy_ak',akVal);else localStorage.removeItem('handy_ak');

  var url=location.origin+location.pathname+'?input=control&room='+camRoomCode+'&code='+encodeURIComponent(ckVal);
  if(akVal)url+='&apikey='+encodeURIComponent(akVal);

  var out=document.getElementById('camLinkOut');
  out.textContent=url;
  out.classList.add('show');

  var btn=document.getElementById('camLinkBtn');
  var orig=btn.textContent;
  try{
    await navigator.clipboard.writeText(url);
    btn.textContent='Copied!';
  }catch(e){
    btn.textContent='Copy failed';
  }
  setTimeout(function(){btn.textContent=orig;},1500);
}

/* ════════════════════════════════════════════════════════
   CONTROL MODE
════════════════════════════════════════════════════════ */
var ctrlPeer=null,ctrlCall=null,ctrlCH=0,ctrlCW=0;
var ctrlDrawing=false,ctrlLastY=null,ctrlLastT=null;

async function initControlMode(roomCode){
  document.getElementById('control-mode').classList.add('active');
  document.getElementById('ctrlRoomPill').textContent=roomCode;
  document.getElementById('ctrlRoomDisplay').textContent=roomCode;
  document.getElementById('ctrlConnStatus').textContent='Connecting to room '+roomCode+'...';

  // Init canvas size
  var ctrlCanvas=document.getElementById('ctrlCanvas');
  ctrlCW=window.innerWidth;ctrlCH=window.innerHeight;
  ctrlCanvas.width=ctrlCW;ctrlCanvas.height=ctrlCH;

  // Update mode pill
  var pill=document.getElementById('ctrlModePill');
  if(useV3){pill.textContent='HDSP';pill.classList.add('on');}
  else{pill.textContent='HAMP';}

  // Connect to camera peer
  var peerId='handyctrl-'+roomCode.replace('-','');
  ctrlPeer=new Peer();

  ctrlPeer.on('open',function(){
    // Pour appeler le peer caméra, on a besoin d'un stream local (même vide)
    // On crée un canvas silencieux comme stream factice
    var fakeCanvas=document.createElement('canvas');
    fakeCanvas.width=1;fakeCanvas.height=1;
    var fakeStream=fakeCanvas.captureStream(1);

    var call=ctrlPeer.call(peerId,fakeStream);

    if(!call){
      document.getElementById('ctrlConnStatus').textContent='Could not reach room '+roomCode;
      return;
    }
    ctrlCall=call;

    call.on('stream',function(remoteStream){
      document.getElementById('ctrlVideo').srcObject=remoteStream;
      document.getElementById('ctrlConnecting').style.display='none';
      // Afficher le sélecteur de mode
      document.getElementById('gameModeSelect').classList.add('active');
      // Cacher la top/bottom bar jusqu'au choix de mode
      document.getElementById('ctrlTopBar').style.display='none';
      document.getElementById('ctrlBottomBar').style.display='none';

      // ── Fix : ouvrir le canal data dès que le flux vidéo arrive ──
      // On se connecte au même peerId que la caméra
      if(!gameDataConn){
        var dc=ctrlPeer.connect(peerId,{reliable:true});
        dc.on('open',function(){
          gameDataConn=dc;
          console.log('Data channel open → gameDataConn ready');
        });
        dc.on('data',function(data){
          handlePeerData(data);
        });
        dc.on('error',function(e){
          console.error('Data channel error:',e);
          gameDataConn=null;
        });
        dc.on('close',function(){
          console.warn('Data channel closed');
          gameDataConn=null;
        });
      }
    });

    call.on('error',function(e){
      document.getElementById('ctrlConnStatus').textContent='Stream error: '+e.message;
    });
  });

  ctrlPeer.on('error',function(e){
    document.getElementById('ctrlConnStatus').textContent='Peer error: '+e.message;
  });

  // Setup canvas touch/mouse events
  initCtrlCanvas();
}

function initCtrlCanvas(){
  // Réutiliser le même moteur que l'onglet Connect
  // mais sur le canvas plein écran avec la vidéo en fond
  var c=document.getElementById('ctrlCanvas');
  ctrlCW=window.innerWidth;ctrlCH=window.innerHeight;
  c.width=ctrlCW;c.height=ctrlCH;

  // Pointer vers le canvas ctrl comme canvas principal
  canvas=c;
  ctx=c.getContext('2d');
  CH=ctrlCH;
  trail=[];

  // Render loop : redessiner le trail par-dessus la vidéo
  function ctrlRenderLoop(){
    if(!document.getElementById('control-mode').classList.contains('active'))return;
    ctx.clearRect(0,0,ctrlCW,ctrlCH);
    // Dessiner le trail (même code que renderCanvas)
    if(trail.length>1){
      for(var k=1;k<trail.length;k++){
        var t=k/trail.length;var c2=velToRGB(trail[k].v);
        ctx.strokeStyle='rgba('+c2[0]+','+c2[1]+','+c2[2]+','+(t*.88)+')';
        ctx.lineWidth=1.5+t*3;ctx.lineCap='round';ctx.lineJoin='round';
        ctx.beginPath();ctx.moveTo(trail[k-1].x,trail[k-1].y);ctx.lineTo(trail[k].x,trail[k].y);ctx.stroke();
      }
    }
    if(trail.length>0){
      var last=trail[trail.length-1];var lc=velToRGB(last.v);
      var g=ctx.createRadialGradient(last.x,last.y,0,last.x,last.y,drawing?22:12);
      g.addColorStop(0,'rgba('+lc[0]+','+lc[1]+','+lc[2]+',.25)');
      g.addColorStop(1,'rgba('+lc[0]+','+lc[1]+','+lc[2]+',0)');
      ctx.beginPath();ctx.arc(last.x,last.y,drawing?22:12,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
      ctx.beginPath();ctx.arc(last.x,last.y,drawing?10:6,0,Math.PI*2);
      ctx.fillStyle='rgb('+lc[0]+','+lc[1]+','+lc[2]+')';ctx.fill();
      ctx.beginPath();ctx.arc(last.x,last.y,drawing?4:2.5,0,Math.PI*2);ctx.fillStyle='#0c0c0f';ctx.fill();
      ctx.fillStyle='rgba('+lc[0]+','+lc[1]+','+lc[2]+',.9)';
      ctx.font='600 13px "Syne",sans-serif';ctx.textAlign='left';
      ctx.fillText(last.p+'%',Math.min(last.x+16,ctrlCW-50),last.y+4);
    }
    requestAnimationFrame(ctrlRenderLoop);
  }
  ctrlRenderLoop();

  // Events — exactement comme initCanvas() mais sur plein écran
  c.addEventListener('mousedown',function(e){
    drawing=true;
    var y=e.clientY;
    lastY=y;lastT=performance.now();
    var p=yToPos(y,ctrlCH);
    trail=[{x:ctrlCW/2,y:cl(y,0,ctrlCH),p:p,v:0}];
    curPos=p;
    document.getElementById('ctrlPosDisplay').innerHTML=p+'<span>%</span>';
    startSendLoop();
  });
  c.addEventListener('mousemove',function(e){
    if(!drawing)return;
    ctrlOnMove(e.clientY);
  });
  c.addEventListener('mouseup',function(){ctrlOnEnd();});
  c.addEventListener('mouseleave',function(){ctrlOnEnd();});
  c.addEventListener('touchstart',function(e){
    drawing=true;
    var y=e.touches[0].clientY;
    lastY=y;lastT=performance.now();
    var p=yToPos(y,ctrlCH);
    trail=[{x:ctrlCW/2,y:cl(y,0,ctrlCH),p:p,v:0}];
    curPos=p;
    document.getElementById('ctrlPosDisplay').innerHTML=p+'<span>%</span>';
    startSendLoop();
  },{passive:true});
  c.addEventListener('touchmove',function(e){
    e.preventDefault();
    if(!drawing)return;
    ctrlOnMove(e.touches[0].clientY);
  },{passive:false});
  c.addEventListener('touchend',function(){ctrlOnEnd();});
}

function ctrlOnMove(clientY){
  var now=performance.now();
  var cy=cl(clientY,0,ctrlCH);
  var pos=yToPos(clientY,ctrlCH);
  var vel=0;
  if(lastY!==null&&lastT!==null){
    var dt=Math.max(now-lastT,5);var dy=Math.abs(clientY-lastY);
    if(useV3)vel=Math.round(cl((dy/dt)*1000*(170/ctrlCH)*sen,0,500));
    else{var bonus=Math.round(cl((dy/dt)*sen*15,0,30));vel=cl(pos+bonus,1,100);}
  }
  lastY=clientY;lastT=now;curPos=pos;curVel=vel;
  trail.push({x:ctrlCW/2,y:cy,p:pos,v:vel});
  if(trail.length>TMAX)trail.shift();
  document.getElementById('ctrlPosDisplay').innerHTML=pos+'<span>%</span>';
}

function ctrlOnEnd(){
  if(!drawing)return;
  drawing=false;stopSendLoop();
  lastY=null;lastT=null;
}

function exitControlMode(){
  if(ctrlCall)ctrlCall.close();
  if(ctrlPeer)ctrlPeer.destroy();
  ctrlPeer=null;ctrlCall=null;ctrlDrawing=false;
  document.getElementById('control-mode').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='flex';
  document.getElementById('ctrlVideo').srcObject=null;
  document.getElementById('cursorDot').style.display='none';
}

/* ── RESET (passif) : le contrôleur a été rechargé / déconnecté ── */
function resetAllGames(){
  // Target
  passiveMode=false;
  var passiveOverlay=document.getElementById('passiveGameOverlay');
  passiveOverlay.classList.remove('active');
  passiveOverlay.querySelectorAll('.passive-circle').forEach(function(el){el.remove();});

  // Guitar Hero
  ghActive=false;
  if(ghRafId){cancelAnimationFrame(ghRafId);ghRafId=null;}
  ghNotes.forEach(function(n){if(n.el&&n.el.parentNode)n.el.parentNode.removeChild(n.el);});
  ghNotes=[];
  document.getElementById('ghOverlay').classList.remove('active');
  document.getElementById('ghCtrlPad').style.display='none';

  // Wheel
  wheelActive=false;wheelSpinning=false;
  if(wheelRestoreTimer){clearTimeout(wheelRestoreTimer);wheelRestoreTimer=null;}
  document.getElementById('wheelOverlay').classList.remove('active');
  document.getElementById('wheelArea').classList.remove('show');
  document.getElementById('wheelResult').classList.remove('show');
  document.getElementById('wheelSetup').classList.remove('active');
}

/* ── PEER DATA MESSAGES ── */
function handlePeerData(data){
  try{
    var msg=JSON.parse(data);
    if(msg.type==='circle_spawn'){
      passiveSpawnCircle(msg.id,msg.x,msg.y,msg.duration);
    } else if(msg.type==='circle_hit'){
      // Cote controleur : cercle touche par le passif
      onCircleHit(msg.id);
    } else if(msg.type==='game_start'){
      // Cote passif : le controleur lance le mode TARGET
      if(!passiveMode) initPassiveGame();
    } else if(msg.type==='game_stop'){
      // Cote passif : le controleur stoppe le jeu
      passiveMode=false;
      var overlay=document.getElementById('passiveGameOverlay');
      overlay.classList.remove('active');
      overlay.querySelectorAll('.passive-circle').forEach(function(el){el.remove();});
    } else if(msg.type==='gh_start'){
      // Côté passif : démarrer Guitar Hero
      ghPassiveStart();
    } else if(msg.type==='gh_stop'){
      // Côté passif : stopper Guitar Hero
      stopGuitarMode();
    } else if(msg.type==='gh_note'){
      // Côté passif : spawner une note reçue du contrôleur
      if(ghActive&&!ghIsCtrl) ghSpawnNote(msg.id,msg.col);
    } else if(msg.type==='gh_hit'){
      // Côté contrôleur : passif a réussi → ralentir HAMP
      ghCombo++; ghMiss=ghMiss||0; ghUpdateHud();
      ghCtrlApplyVelocity(msg.speed, false, msg.noteSpeed);
    } else if(msg.type==='gh_miss'){
      // Côté contrôleur : passif a raté → accélérer HAMP
      ghCombo=0; ghMiss++; ghUpdateHud();
      ghCtrlApplyVelocity(msg.speed, !ghStarted, msg.noteSpeed);
    } else if(msg.type==='wheel_init'){
      // Côté passif : le contrôleur a configuré la roue
      wheelPassiveStart(msg.config);
    } else if(msg.type==='wheel_spin'){
      // Côté passif : rejouer l'animation de spin du contrôleur
      if(wheelActive&&!wheelIsCtrl) wheelDoSpin(msg.resultIndex,msg.rotation,msg.effectId);
    } else if(msg.type==='wheel_stop'){
      // Côté passif : le contrôleur a arrêté le mode roue
      wheelActive=false;wheelSpinning=false;
      document.getElementById('wheelOverlay').classList.remove('active');
      document.getElementById('wheelArea').classList.remove('show');
      document.getElementById('wheelResult').classList.remove('show');
    }
  }catch(e){console.error('handlePeerData error:',e,data);}
}

/* ── URL PARAMS ── */
window.addEventListener('load',function(){
  var params=new URLSearchParams(window.location.search);
  var input=params.get('input');
  var roomCode=params.get('room');
  var urlCk=params.get('code');
  var urlAk=params.get('apikey');

  // Load saved keys
  var savedCk=urlCk||localStorage.getItem('handy_ck')||'';
  var savedAk=urlAk||localStorage.getItem('handy_ak')||'';

  if(input==='camera'){
    // Camera mode: activate camera, generate room code, wait for controller
    initCameraMode();
  } else if(input==='control'&&roomCode){
    // Control mode: connect to Handy, then open camera stream
    ck=savedCk;ak=savedAk;
    if(!ck){alert('No Connection Key found. Add &code=YOURKEY to the URL.');return;}
    // Try to connect to Handy first
    (async function(){
      if(ak){
        try{token=await getToken();useV3=true;}catch(e){useV3=false;token='';}
      }
      try{await call('/mode','PUT',{mode:useV3?4:2});}catch(e){}
      initControlMode(roomCode);
    })();
  }
  // Sans param d'URL : page blanche, rien à faire
});
