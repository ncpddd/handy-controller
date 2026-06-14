/* ── CONFIG ── */
var V2='https://www.handyfeeling.com/api/handy/v2';
var V3='https://www.handyfeeling.com/api/handy-rest/v3';
var MIN_DUR_MS=80,MAX_DUR_MS=800;
var SAMPLE_INTERVAL_MS=50;        // cadence d'enregistrement des échantillons de position
var SEGMENT_SAMPLES=2;            // nb d'échantillons par segment
var SEGMENT_MS=SAMPLE_INTERVAL_MS*SEGMENT_SAMPLES; // 100ms : durée "réelle" d'un segment
var STREAM_LOOKAHEAD_MIN=80,STREAM_LOOKAHEAD_MAX=400; // ms, anticipation bornée par le RTT mesuré

/* ── STATE ── */
var ck='',ak='',token='',useV3=false;
var canvas,ctx,CH;
var drawing=false,lastY=null,lastT=null;
var curPos=50,curVel=0,sen=1.5;
var trail=[],TMAX=200;
var sendInterval=null;
var segmentSamples=[]; // {pos,t} échantillons du segment en cours d'enregistrement
var xptBusy=false;     // une seule requête /hdsp/xpt en vol à la fois
var rttEstimate=150;   // ms, moyenne mobile (EMA) du round-trip mesuré
var basicActive=false; // true uniquement quand le mode BASIC est sélectionné (évite que le canvas pilote le Handy dans les autres modes)

/* État partagé entre les modes de jeu */
var gameDataConn=null;      // connexion PeerJS données vers le passif
var passiveMode=false;      // true = on est le passif (mode TARGET)

/* Plafond de hauteur/course réglé côté passif (0..1). Toutes les positions et les max de
   plage de course envoyés au Handy sont multipliés par ce facteur (ex : 80% de course
   demandé × plafond 80% = 64% réel). Côté contrôleur, fixé via le message 'max_height'. */
var passiveMaxH=1;
var camMaxHeightPct=100;    // côté passif : valeur courante du slider (pour la renvoyer à la connexion)
var maxHReapplyTimer=null;  // côté contrôleur : debounce du ré-upload HSSP quand le plafond change

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
  try{
    if(useV3)await call('/hdsp/xpt','PUT',{xp:Math.round(curPos*passiveMaxH)});
    else await fetch(V2+'/hdsp/xpt',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json'},body:JSON.stringify({stopOnTarget:true,immediateResponse:true,duration:MIN_DUR_MS,position:(curPos/100)*passiveMaxH})});
  }catch(e){}
  var ms=document.getElementById('ms');if(ms)ms.textContent='idle';
}

/* ── Retour au menu de sélection de mode (BASIC) ── */
function backToModeSelect(){
  stopHandy();
  basicActive=false;
  if(drawing){drawing=false;stopSendLoop();segmentSamples=[];}
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';
  document.getElementById('gameModeSelect').classList.add('active');
}

/* ── CONTROL CANVAS ── */
function cl(v,a,b){return Math.max(a,Math.min(b,v));}
function yToPos(y,h){return Math.round(100-(cl(y,0,h)/h)*100);}

function startSendLoop(){
  if(sendInterval)return;
  segmentSamples=[];
  sendInterval=setInterval(function(){if(drawing)recordSample();},SAMPLE_INTERVAL_MS);
}
function stopSendLoop(){if(sendInterval){clearInterval(sendInterval);sendInterval=null;}}

/* ── SEGMENT STREAMING ENGINE ── */
function recordSample(){
  var now=performance.now();
  segmentSamples.push({pos:curPos,t:now});
  if(segmentSamples.length>=SEGMENT_SAMPLES){
    var closed=segmentSamples;
    // le dernier point du segment fermé devient le 1er point du suivant (continuité)
    segmentSamples=[closed[closed.length-1]];
    playSegment(closed);
  }
}

async function playSegment(samples){
  if(!ck)return;
  if(xptBusy)return; // requête précédente encore en vol : on saute ce segment, le suivant rattrapera

  var n=samples.length;
  var t0=samples[0].t;
  var sumT=0,sumP=0,sumTT=0,sumTP=0;
  samples.forEach(function(s){
    var t=s.t-t0;
    sumT+=t;sumP+=s.pos;sumTT+=t*t;sumTP+=t*s.pos;
  });
  var denom=n*sumTT-sumT*sumT;
  var slope=denom!==0?(n*sumTP-sumT*sumP)/denom:0; // %/ms
  var intercept=(sumP-slope*sumT)/n;
  var tEnd=samples[n-1].t-t0;
  var posAtEnd=cl(slope*tEnd+intercept,0,100);

  var lookahead=cl(rttEstimate,STREAM_LOOKAHEAD_MIN,STREAM_LOOKAHEAD_MAX);
  var target=cl(Math.round(posAtEnd+slope*lookahead),0,100);
  var duration=cl(Math.round(SEGMENT_MS+rttEstimate),MIN_DUR_MS,MAX_DUR_MS);

  xptBusy=true;
  var sentAt=performance.now();
  try{
    var r=await fetch(V2+'/hdsp/xpt',{method:'PUT',
      headers:{'X-Connection-Key':ck,'Content-Type':'application/json'},
      body:JSON.stringify({stopOnTarget:true,immediateResponse:true,duration:duration,position:(target/100)*passiveMaxH})});
    if(r.ok)rttEstimate=Math.round(rttEstimate*0.7+(performance.now()-sentAt)*0.3);
  }catch(e){console.warn('xpt error:',e);}
  finally{xptBusy=false;}
}

/* ── RENDER CONTROL CANVAS ── */
function velToRGB(vel){
  if(useV3){if(vel>180)return[255,77,77];if(vel>80)return[255,140,58];return[77,159,255];}
  else{if(vel>70)return[255,77,77];if(vel>35)return[255,140,58];return[77,159,255];}
}

/* ════════════════════════════════════════════════════════
   CAMERA MODE
════════════════════════════════════════════════════════ */
var camPeer=null,camConn=null,camRoomCode='';
var camVideoHidden=true; // côté passif : cache/révèle le flux vidéo des deux côtés (caché par défaut)
var camFovShown=false; // côté passif : afficher le cadre représentant ce que voit le contrôleur
var ctrlViewport=null; // côté passif : {w,h} de l'écran du contrôleur, reçu via data channel

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
      // Synchroniser l'état caché/révélé de la caméra avec le contrôleur qui vient de se connecter
      conn.send(JSON.stringify({type:'cam_visibility',hidden:camVideoHidden}));
      // Envoyer le plafond de hauteur courant (au cas où il a été réglé avant la connexion)
      conn.send(JSON.stringify({type:'max_height',value:camMaxHeightPct}));
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

/* ── Visibilité caméra (passif) : cache/révèle le flux vidéo des deux côtés ── */
function camToggleVideoVisibility(){
  camVideoHidden=!camVideoHidden;
  document.getElementById('camHideOverlay').classList.toggle('show',camVideoHidden);
  document.getElementById('camVisibilityBtn').textContent=camVideoHidden?'🙈':'👁️';
  if(camConn&&camConn.open){
    camConn.send(JSON.stringify({type:'cam_visibility',hidden:camVideoHidden}));
  }
}

/* ── Plafond de hauteur/course (passif) ── */
function camOnMaxHeightInput(val){
  camMaxHeightPct=cl(parseInt(val,10),0,100);
  document.getElementById('camMaxHeightVal').textContent=camMaxHeightPct+'%';
  if(camConn&&camConn.open){
    camConn.send(JSON.stringify({type:'max_height',value:camMaxHeightPct}));
  }
}

/* ── Cadre "ce que voit le contrôleur" (passif) ── */
function camToggleFov(){
  camFovShown=!camFovShown;
  document.getElementById('camFovBtn').classList.toggle('active',camFovShown);
  camUpdateFovOverlay();
}

// Calcule le rectangle (en pixels écran passif) correspondant à la portion de la vidéo
// visible sur l'écran du contrôleur, en tenant compte de object-fit:cover des deux côtés.
function camUpdateFovOverlay(){
  var overlay=document.getElementById('camFovOverlay');
  if(!camFovShown||!ctrlViewport){overlay.style.display='none';return;}
  var video=document.getElementById('camVideo');
  var vw=video.videoWidth,vh=video.videoHeight;
  if(!vw||!vh){overlay.style.display='none';return;}
  var pw=window.innerWidth,ph=window.innerHeight;

  function visibleRect(w,h){
    var viewAR=w/h,videoAR=vw/vh;
    if(viewAR>videoAR){
      var visH=vw/viewAR;
      return {x:0,y:(vh-visH)/2,w:vw,h:visH};
    } else {
      var visW=vh*viewAR;
      return {x:(vw-visW)/2,y:0,w:visW,h:vh};
    }
  }

  var passiveRect=visibleRect(pw,ph);
  var ctrlRect=visibleRect(ctrlViewport.w,ctrlViewport.h);
  var scale=pw/passiveRect.w;

  overlay.style.display='block';
  overlay.style.left=((ctrlRect.x-passiveRect.x)*scale)+'px';
  overlay.style.top=((ctrlRect.y-passiveRect.y)*scale)+'px';
  overlay.style.width=(ctrlRect.w*scale)+'px';
  overlay.style.height=(ctrlRect.h*scale)+'px';
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
          dc.send(JSON.stringify({type:'ctrl_viewport',w:window.innerWidth,h:window.innerHeight}));
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
    // Hors mode BASIC, le canvas n'affiche pas le trail/curseur
    if(!basicActive){requestAnimationFrame(ctrlRenderLoop);return;}
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
    if(!basicActive)return;
    drawing=true;
    var y=e.clientY;
    lastY=y;lastT=performance.now();
    segmentSamples=[];
    var p=yToPos(y,ctrlCH);
    trail=[{x:ctrlCW/2,y:cl(y,0,ctrlCH),p:p,v:0}];
    curPos=p;
    document.getElementById('ctrlPosDisplay').innerHTML=p+'<span>%</span>';
    startSendLoop();
  });
  c.addEventListener('mousemove',function(e){
    if(!basicActive||!drawing)return;
    ctrlOnMove(e.clientY);
  });
  c.addEventListener('mouseup',function(){if(basicActive)ctrlOnEnd();});
  c.addEventListener('mouseleave',function(){if(basicActive)ctrlOnEnd();});
  c.addEventListener('touchstart',function(e){
    if(!basicActive)return;
    drawing=true;
    var y=e.touches[0].clientY;
    lastY=y;lastT=performance.now();
    segmentSamples=[];
    var p=yToPos(y,ctrlCH);
    trail=[{x:ctrlCW/2,y:cl(y,0,ctrlCH),p:p,v:0}];
    curPos=p;
    document.getElementById('ctrlPosDisplay').innerHTML=p+'<span>%</span>';
    startSendLoop();
  },{passive:true});
  c.addEventListener('touchmove',function(e){
    if(!basicActive)return;
    e.preventDefault();
    if(!drawing)return;
    ctrlOnMove(e.touches[0].clientY);
  },{passive:false});
  c.addEventListener('touchend',function(){if(basicActive)ctrlOnEnd();});
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
  segmentSamples=[];
  // Commande finale sans anticipation : se poser exactement à la position relâchée
  if(ck){
    fetch(V2+'/hdsp/xpt',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json'},
      body:JSON.stringify({stopOnTarget:true,immediateResponse:true,duration:MIN_DUR_MS,position:(curPos/100)*passiveMaxH})}).catch(function(){});
  }
}

function exitControlMode(){
  if(ctrlCall)ctrlCall.close();
  if(ctrlPeer)ctrlPeer.destroy();
  ctrlPeer=null;ctrlCall=null;ctrlDrawing=false;
  document.getElementById('control-mode').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='flex';
  document.getElementById('ctrlVideo').srcObject=null;
  document.getElementById('cursorDot').style.display='none';
  document.getElementById('ctrlHideOverlay').classList.add('show');
}

/* ── RESET (passif) : le contrôleur a été rechargé / déconnecté ── */
function resetAllGames(){
  // Visibilité caméra (cachée par défaut)
  camVideoHidden=true;
  document.getElementById('camHideOverlay').classList.add('show');
  document.getElementById('camVisibilityBtn').textContent='🙈';

  // Cadre "ce que voit le contrôleur"
  camFovShown=false;
  ctrlViewport=null;
  document.getElementById('camFovOverlay').style.display='none';
  document.getElementById('camFovBtn').classList.remove('active');

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
  wheelActive=false;wheelSpinning=false;wheelSpinLock=false;
  if(wheelRestoreTimer){clearTimeout(wheelRestoreTimer);wheelRestoreTimer=null;}
  if(wheelFlashTimer){clearTimeout(wheelFlashTimer);wheelFlashTimer=null;}
  document.getElementById('wheelEdgeFlash').className='';
  document.getElementById('wheelOverlay').classList.remove('active');
  document.getElementById('wheelArea').classList.remove('show');
  document.getElementById('wheelResult').classList.remove('show');
  document.getElementById('wheelSetup').classList.remove('active');

  // Shell Game
  shellActive=false;shellRoundActive=false;shellGuessable=false;
  document.getElementById('shellOverlay').classList.remove('active');
  document.getElementById('shellHud').classList.remove('show');

  // Rally (1 vs mur)
  rallyActive=false;
  if(rallyRafId){cancelAnimationFrame(rallyRafId);rallyRafId=null;}
  document.getElementById('rallyOverlay').classList.remove('active');
  document.getElementById('rallyHud').classList.remove('show');
  document.getElementById('rallyArea').innerHTML='';
  rallyBalls=[];

  // Control Deck
  cdActive=false;cdHampRunning=false;cdLaunching=false;
  if(cdVelocityThrottle){clearTimeout(cdVelocityThrottle);cdVelocityThrottle=null;}
  if(cdRangeThrottle){clearTimeout(cdRangeThrottle);cdRangeThrottle=null;}
  cdStopMarkerLoop();
  document.getElementById('cdOverlay').classList.remove('active','is-ctrl');
  document.getElementById('cdHud').classList.remove('show');

  // Auto-Pilot
  apActive=false;apPlaying=false;apLaunching=false;
  if(apLabelTimer){clearInterval(apLabelTimer);apLabelTimer=null;}
  document.getElementById('apOverlay').classList.remove('active','is-ctrl');
  document.getElementById('apHud').classList.remove('show');
  document.getElementById('apSetup').classList.remove('active');

  // Dessin
  dessinActive=false;dessinPlaying=false;dessinLaunching=false;
  if(dessinRaf){cancelAnimationFrame(dessinRaf);dessinRaf=null;}
  if(dessinLabelTimer){clearInterval(dessinLabelTimer);dessinLabelTimer=null;}
  document.getElementById('dessinOverlay').classList.remove('active','is-ctrl');
  document.getElementById('dessinHud').classList.remove('show');
  document.getElementById('dessinSetup').classList.remove('active');

  // Hold
  holdActive=false;holdHolding=false;holdHampRunning=false;holdLaunching=false;
  if(holdTickTimer){clearInterval(holdTickTimer);holdTickTimer=null;}
  document.getElementById('holdOverlay').classList.remove('active','is-ctrl');
  document.getElementById('holdHud').classList.remove('show');

  // Passive speed HUD (commun à tous les modes)
  document.getElementById('passiveSpeedHud').classList.remove('show');
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
      document.getElementById('passiveSpeedHud').classList.remove('show');
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
      ghCtrlApplyVelocity(msg.speed, !ghStarted, msg.noteSpeed);
    } else if(msg.type==='gh_miss'){
      // Côté contrôleur : passif a raté → accélérer HAMP + réduire le délai entre notes
      ghCombo=0; ghMiss++; ghUpdateHud();
      ghColCooldown=Math.max(GH_COL_COOLDOWN_MIN,ghColCooldown-GH_COL_COOLDOWN_DECAY);
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
      document.getElementById('passiveSpeedHud').classList.remove('show');
    } else if(msg.type==='shell_init'){
      // Côté passif : le contrôleur a lancé le Shell Game
      shellPassiveStart();
    } else if(msg.type==='shell_round'){
      // Côté passif : rejouer la manche (mélange) du contrôleur
      if(shellActive&&!shellIsCtrl) shellRunRound(msg.startBallCup,msg.seq,msg.swapDur);
    } else if(msg.type==='shell_guess'){
      // Côté contrôleur : le passif a deviné → appliquer l'effet sur le Handy
      shellApplyResult(msg.cupId,msg.correct);
    } else if(msg.type==='shell_stop'){
      // Côté passif : le contrôleur a arrêté le Shell Game
      shellActive=false;shellRoundActive=false;shellGuessable=false;
      document.getElementById('shellOverlay').classList.remove('active');
      document.getElementById('passiveSpeedHud').classList.remove('show');
    } else if(msg.type==='rally_init'){
      // Côté passif : le contrôleur a lancé le mode RALLY
      rallyPassiveStart({ballCount:msg.ballCount,ballSpeedLevel:msg.ballSpeedLevel,paddleSizeLevel:msg.paddleSizeLevel});
    } else if(msg.type==='rally_config'){
      // Côté passif : le contrôleur a changé la config en direct
      rallyApplyConfig({ballCount:msg.ballCount,ballSpeedLevel:msg.ballSpeedLevel,paddleSizeLevel:msg.paddleSizeLevel});
    } else if(msg.type==='rally_event'){
      // Côté contrôleur : le passif a touché le mur ou raté une balle
      rallyApplyResult(msg.event);
    } else if(msg.type==='rally_state'){
      // Côté contrôleur : état de la partie (balles, raquette) envoyé par le passif
      rallyApplyState(msg);
    } else if(msg.type==='rally_stop'){
      // Côté passif : le contrôleur a arrêté le mode RALLY
      rallyPassiveStop();
    } else if(msg.type==='cd_init'){
      // Côté passif : le contrôleur a lancé le mode CONTROL DECK
      cdPassiveStart({speedPct:msg.speedPct,rangeMin:msg.rangeMin,rangeMax:msg.rangeMax,running:msg.running});
    } else if(msg.type==='cd_update'){
      // Côté passif : nouvelles valeurs de vitesse/plage du CONTROL DECK
      cdApplyUpdate(msg);
    } else if(msg.type==='cd_stop'){
      // Côté passif : le contrôleur a arrêté le mode CONTROL DECK
      cdActive=false;
      cdStopMarkerLoop();
      document.getElementById('cdOverlay').classList.remove('active','is-ctrl');
      document.getElementById('passiveSpeedHud').classList.remove('show');
    } else if(msg.type==='ap_init'){
      // Côté passif : le contrôleur a (re)lancé/changé le preset AUTO-PILOT
      if(apActive)apApplyPreset(msg.presetId,msg.startTime);
      else apPassiveStart(msg);
    } else if(msg.type==='ap_stop'){
      // Côté passif : le contrôleur a arrêté le mode AUTO-PILOT
      apActive=false;
      document.getElementById('apOverlay').classList.remove('active','is-ctrl');
      document.getElementById('passiveSpeedHud').classList.remove('show');
    } else if(msg.type==='dessin_init'){
      // Côté passif : le contrôleur a (re)lancé une courbe DESSIN
      if(dessinActive)dessinApplyCurve(msg.points,msg.startTime,msg.periodMs);
      else dessinPassiveStart(msg);
    } else if(msg.type==='dessin_stop'){
      // Côté passif : le contrôleur a arrêté le mode DESSIN
      dessinPassiveStop();
    } else if(msg.type==='hold_init'){
      // Côté passif : le contrôleur a lancé le mode HOLD
      holdPassiveStart();
    } else if(msg.type==='hold_update'){
      // Côté passif : nouvelle intensité du mode HOLD
      holdApplyUpdate(msg);
    } else if(msg.type==='hold_stop'){
      // Côté passif : le contrôleur a arrêté le mode HOLD
      holdActive=false;
      document.getElementById('holdOverlay').classList.remove('active','is-ctrl');
      document.getElementById('passiveSpeedHud').classList.remove('show');
    } else if(msg.type==='max_height'){
      // Côté contrôleur : le passif règle le plafond de hauteur/course
      passiveMaxH=cl((msg.value!=null?msg.value:100)/100,0,1);
      reapplyMaxHeight();
    } else if(msg.type==='ctrl_viewport'){
      // Côté passif : mémoriser la taille d'écran du contrôleur pour le cadre FOV
      ctrlViewport={w:msg.w,h:msg.h};
      camUpdateFovOverlay();
    } else if(msg.type==='cam_visibility'){
      // Côté contrôleur : le passif cache/révèle son flux vidéo
      document.getElementById('ctrlHideOverlay').classList.toggle('show',msg.hidden);
    } else if(msg.type==='speed_update'){
      // Côté passif : afficher la vitesse/position courante du Handy envoyée par le contrôleur
      if(msg.mode==='gh'){
        ghSpeed=msg.speed; ghHampRunning=msg.running; ghUpdateHud();
      } else if(msg.mode==='ap'){
        document.getElementById('passiveSpeedHud').textContent=msg.running
          ? 'Position: '+Math.round(msg.speed*100)+'%'
          : 'Position: pause';
      } else {
        document.getElementById('passiveSpeedHud').textContent=msg.running
          ? 'Speed: '+Math.round(msg.speed*100)+'%'
          : 'Speed: pause';
      }
    }
  }catch(e){console.error('handlePeerData error:',e,data);}
}

/* Ré-applique le plafond de hauteur au mode actif quand le passif le change (contrôleur).
   BASIC : la prochaine commande applique déjà le facteur (on pose une commande immédiate si
   le doigt n'est pas en train de dessiner). CONTROL DECK : on renvoie sa plage de course
   (re-scalée). WHEEL : appliqué automatiquement au prochain wheelSetRange. AUTO-PILOT / DRAW :
   le script HSSP doit être reconstruit/rejoué (coûteux → débounce). */
// Course physique du Handy plafonnée à [0, passiveMaxH] (V3). Utilisé par les modes qui ne
// pilotent que la vitesse (HOLD, TARGET, GUITAR, SHELL, RALLY) et comme course de repos WHEEL,
// pour qu'ils respectent aussi le plafond de hauteur réglé côté passif.
function applyStrokeCap(){
  if(!ck||!token)return;
  fetch(V3+'/hamp/stroke',{method:'PUT',
    headers:{'X-Connection-Key':ck,'Authorization':'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({min:0,max:passiveMaxH})}).catch(function(){});
}

function reapplyMaxHeight(){
  if(basicActive&&ck&&!drawing){
    fetch(V2+'/hdsp/xpt',{method:'PUT',headers:{'X-Connection-Key':ck,'Content-Type':'application/json'},
      body:JSON.stringify({stopOnTarget:true,immediateResponse:true,duration:MIN_DUR_MS,position:(curPos/100)*passiveMaxH})}).catch(function(){});
  }
  // modes à plage propre (déjà mise à l'échelle dans leur setRange)
  if(typeof cdActive!=='undefined'&&cdActive&&cdIsCtrl&&cdHampRunning)cdSetRange(cdRangeMin,cdRangeMax);
  // modes vitesse + WHEEL : on plafonne la course physique [0, plafond]
  if((typeof holdHampRunning!=='undefined'&&holdHampRunning)||
     (typeof gameHampRunning!=='undefined'&&gameHampRunning)||
     (typeof ghHampRunning!=='undefined'&&ghHampRunning)||
     (typeof shellHampRunning!=='undefined'&&shellHampRunning)||
     (typeof rallyHampRunning!=='undefined'&&rallyHampRunning)||
     (typeof wheelHampRunning!=='undefined'&&wheelHampRunning)){
    applyStrokeCap();
  }

  if(maxHReapplyTimer)clearTimeout(maxHReapplyTimer);
  maxHReapplyTimer=setTimeout(function(){
    maxHReapplyTimer=null;
    if(typeof apActive!=='undefined'&&apActive&&apIsCtrl&&apPlaying&&typeof apReapplyMaxHeight==='function')apReapplyMaxHeight();
    if(typeof dessinActive!=='undefined'&&dessinActive&&dessinIsCtrl&&dessinPlaying&&typeof dessinReapplyMaxHeight==='function')dessinReapplyMaxHeight();
  },350);
}

// Recalcule/rediffuse les tailles d'écran selon le rôle quand la fenêtre change de taille
window.addEventListener('resize',function(){
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'ctrl_viewport',w:window.innerWidth,h:window.innerHeight}));
  }
  if(camFovShown)camUpdateFovOverlay();
});

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
