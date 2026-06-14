/* ════════════════════════════════════════════════════════
   DRAW MODE — the controller records a live up/down motion;
   the recorded position-over-time becomes a curve that loops
   on the Handy for exactly the duration of the recording (HSSP).
════════════════════════════════════════════════════════ */

var DESSIN_REC_MS=30;             // sampling cadence while recording (ms)
var DESSIN_MIN_PERIOD=500;        // ms, minimum usable recording length
var DESSIN_MAX_PERIOD=30000;      // ms, recording auto-stops past this
var DESSIN_SMOOTH=2;              // light smoothing radius (samples) — stay faithful to the motion

/* ── State ── */
var dessinActive=false;
var dessinIsCtrl=false;
var dessinPlaying=false;
var dessinLaunching=false;
var dessinCurve=null;             // array of ints 0..100 (position, 100 = top)
var dessinPeriodMs=0;             // loop length = recording duration
var dessinScriptUrl=null;
var dessinStartTime=0;
var dessinRaf=null;
var dessinLabelTimer=null;

/* ── Recording ── */
var dessinCv=null,dessinCtx=null;
var dessinRecording=false;
var dessinRecInterval=null;
var dessinRecStartT=0;
var dessinCurPos=50;              // live finger position (0..100)
var dessinSamples=[];             // recorded {t,pos} (t = ms from start)

/* ── Start (controller) ── */
function startDessinMode(){
  document.getElementById('gameModeSelect').classList.remove('active');
  document.getElementById('ctrlConnecting').style.display='none';
  document.getElementById('ctrlTopBar').style.display='none';
  document.getElementById('ctrlBottomBar').style.display='none';

  basicActive=false;
  dessinActive=true;dessinIsCtrl=true;dessinPlaying=false;dessinLaunching=false;
  dessinCurve=null;dessinScriptUrl=null;dessinSamples=[];dessinPeriodMs=0;

  document.getElementById('dessinSetup').classList.add('active');
  dessinInitCanvas();
  dessinClear();
}

function dessinCancelSetup(){
  dessinStopRecording();
  dessinActive=false;dessinIsCtrl=false;
  document.getElementById('dessinSetup').classList.remove('active');
  document.getElementById('gameModeSelect').classList.add('active');
}

/* ── Recording pad ── */
function dessinInitCanvas(){
  dessinCv=document.getElementById('dessinCanvas');
  dessinCtx=dessinCv.getContext('2d');
  dessinResizeCanvas();
  if(!dessinCv._bound){
    dessinCv._bound=true;
    dessinCv.addEventListener('mousedown',function(e){dessinRecStart(e.clientY);});
    dessinCv.addEventListener('mousemove',function(e){if(dessinRecording)dessinCurPos=dessinPosFromY(e.clientY);});
    window.addEventListener('mouseup',function(){if(dessinRecording)dessinRecEnd();});
    dessinCv.addEventListener('touchstart',function(e){e.preventDefault();dessinRecStart(e.touches[0].clientY);},{passive:false});
    dessinCv.addEventListener('touchmove',function(e){e.preventDefault();if(dessinRecording)dessinCurPos=dessinPosFromY(e.touches[0].clientY);},{passive:false});
    dessinCv.addEventListener('touchend',function(e){e.preventDefault();if(dessinRecording)dessinRecEnd();},{passive:false});
  }
}

function dessinResizeCanvas(){
  var r=dessinCv.getBoundingClientRect();
  dessinCv.width=Math.max(2,Math.round(r.width));
  dessinCv.height=Math.max(2,Math.round(r.height));
}
function dessinPosFromY(clientY){
  var r=dessinCv.getBoundingClientRect();
  return cl(Math.round(100-((clientY-r.top)/r.height)*100),0,100);
}

function dessinRecStart(clientY){
  dessinResizeCanvas();
  dessinCurPos=dessinPosFromY(clientY);
  dessinRecording=true;
  dessinRecStartT=performance.now();
  dessinSamples=[{t:0,pos:dessinCurPos}];
  dessinCurve=null;
  document.getElementById('dessinLaunchBtn').disabled=true;
  if(dessinRecInterval)clearInterval(dessinRecInterval);
  dessinRecInterval=setInterval(dessinRecTick,DESSIN_REC_MS);
  dessinRedraw();
}
function dessinRecTick(){
  if(!dessinRecording)return;
  var t=performance.now()-dessinRecStartT;
  dessinSamples.push({t:t,pos:dessinCurPos});
  document.getElementById('dessinRecStatus').textContent='● REC '+(t/1000).toFixed(1)+'s';
  dessinRedraw();
  if(t>=DESSIN_MAX_PERIOD)dessinRecEnd();
}
function dessinStopRecording(){
  dessinRecording=false;
  if(dessinRecInterval){clearInterval(dessinRecInterval);dessinRecInterval=null;}
}
function dessinRecEnd(){
  if(!dessinRecording)return;
  dessinStopRecording();
  var built=dessinBuildCurve(dessinSamples);
  if(built){
    dessinCurve=built.curve;dessinPeriodMs=built.period;
    document.getElementById('dessinLaunchBtn').disabled=false;
    document.getElementById('dessinRecStatus').textContent='Recorded '+(dessinPeriodMs/1000).toFixed(1)+'s — Play or Clear to redo';
  }else{
    document.getElementById('dessinRecStatus').textContent='Too short — hold and move up/down to record';
  }
  dessinRedraw();
}

function dessinClear(){
  dessinStopRecording();
  dessinSamples=[];dessinCurve=null;dessinPeriodMs=0;
  document.getElementById('dessinLaunchBtn').disabled=true;
  document.getElementById('dessinRecStatus').textContent='Hold and move up/down to record';
  dessinRedraw();
}

/* ── Render (live trace + smoothed preview) ── */
function dessinRedraw(){
  if(!dessinCtx)return;
  var ctx=dessinCtx,W=dessinCv.width,H=dessinCv.height;
  ctx.clearRect(0,0,W,H);
  if(dessinCurve){
    // only the smoothed curve (what will actually play) — clean, no raw overlay
    ctx.strokeStyle='rgba(200,255,0,0.95)';ctx.lineWidth=3;ctx.lineJoin='round';ctx.lineCap='round';
    ctx.beginPath();
    for(var i=0;i<dessinCurve.length;i++){
      var x=(i/(dessinCurve.length-1))*W;
      var y=H-(dessinCurve[i]/100)*H;
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }else if(dessinSamples.length>1){
    var period=dessinSamples[dessinSamples.length-1].t||1;
    dessinDrawPolyline(ctx,dessinSamples,function(s){return s.t;},function(s){return s.pos;},period,'rgba(200,255,0,0.9)',2.5);
  }
}
function dessinDrawPolyline(ctx,arr,fx,fy,span,color,w){
  if(!arr||arr.length<2)return;
  var W=dessinCv.width,H=dessinCv.height;
  ctx.strokeStyle=color;ctx.lineWidth=w;ctx.lineJoin='round';ctx.lineCap='round';
  ctx.beginPath();
  for(var i=0;i<arr.length;i++){
    var x=(fx(arr[i])/(span||1))*W;
    var y=H-(fy(arr[i])/100)*H;
    if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.stroke();
}

/* ── Pipeline: faithful resample then heavy smoothing (very rounded, anti-jitter) ── */
function dessinBuildCurve(samples){
  if(!samples||samples.length<2)return null;
  var period=samples[samples.length-1].t;
  if(period<DESSIN_MIN_PERIOD)return null;

  // resolution ~40ms, bounded, so detail is kept whatever the recording length
  var N=cl(Math.round(period/40),60,800);

  // 1. uniform time resampling (linear interpolation between recorded samples)
  var grid=new Array(N);
  var j=0;
  for(var i=0;i<N;i++){
    var tt=(i/(N-1))*period;
    while(j<samples.length-2&&samples[j+1].t<tt)j++;
    var a=samples[j],b=samples[j+1];
    var span=(b.t-a.t)||1;
    var f=cl((tt-a.t)/span,0,1);
    grid[i]=a.pos+(b.pos-a.pos)*f;
  }

  // 2. light smoothing only → stays faithful to the recorded motion (the grey trace),
  //    just removes single-sample sampling noise without rounding the shape away
  grid=dessinSmooth(grid,DESSIN_SMOOTH);

  var curve=new Array(N);
  for(var k=0;k<N;k++)curve[k]=cl(Math.round(grid[k]),0,100);
  return {curve:curve,period:Math.round(period)};
}

function dessinSmooth(arr,radius){
  if(radius<1)return arr.slice();
  var sigma=radius/2,kernel=[],sum=0,i,k;
  for(i=-radius;i<=radius;i++){var wgt=Math.exp(-(i*i)/(2*sigma*sigma));kernel.push(wgt);sum+=wgt;}
  var out=new Array(arr.length);
  for(i=0;i<arr.length;i++){
    var acc=0;
    for(k=-radius;k<=radius;k++){
      var idx=cl(i+k,0,arr.length-1); // edges: clamp to extreme value
      acc+=arr[idx]*kernel[k+radius];
    }
    out[i]=acc/sum;
  }
  return out;
}

// position 0..100 at progress p (0..1) along the curve
function dessinSampleCurve(p){
  if(!dessinCurve)return 50;
  var x=cl(p,0,1)*(dessinCurve.length-1);
  var i=Math.floor(x),f=x-i;
  if(i>=dessinCurve.length-1)return dessinCurve[dessinCurve.length-1];
  return dessinCurve[i]+(dessinCurve[i+1]-dessinCurve[i])*f;
}

/* ── HSSP (controller only) ── */
function dessinHdrs(json){
  var h={'X-Connection-Key':ck,'Authorization':'Bearer '+token};
  if(json)h['Content-Type']='application/json';
  return h;
}
function dessinSleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

function dessinBuildCsv(){
  var steps=cl(Math.round(dessinPeriodMs/50),20,600);
  var lines=[];
  for(var i=0;i<=steps;i++){
    var p=i/steps;
    var t=Math.round(p*dessinPeriodMs);
    // plafond de hauteur passif : on met à l'échelle la position
    var pos=Math.round(cl(dessinSampleCurve(p),0,100)*passiveMaxH);
    lines.push(t+','+pos);
  }
  return lines.join('\n');
}

async function dessinUploadScript(){
  var csv=dessinBuildCsv();
  var fd=new FormData();
  fd.append('file',new Blob([csv],{type:'text/csv'}),'draw.csv');
  var r=await fetch('https://www.handyfeeling.com/api/hosting/v2/upload',{method:'POST',body:fd});
  var d=await r.json();
  return d.url;
}

async function dessinStartPlayback(){
  if(dessinLaunching)return null;
  dessinLaunching=true;
  var playTime=null;
  try{
    var url=await dessinUploadScript();
    dessinScriptUrl=url;
    await fetch(V3+'/hssp/setup',{method:'PUT',headers:dessinHdrs(true),body:JSON.stringify({url:url})});
    await dessinSleep(400);
    playTime=Date.now();
    await fetch(V3+'/hssp/play',{method:'PUT',headers:dessinHdrs(true),body:JSON.stringify({start_time:0,server_time:playTime,loop:true})});
    dessinPlaying=true;
  }catch(e){console.error('DRAW HSSP start error:',e);}
  finally{dessinLaunching=false;}
  return playTime;
}

async function dessinStopPlayback(){
  if(!dessinPlaying)return;
  try{await fetch(V3+'/hssp/stop',{method:'PUT',headers:dessinHdrs(false)});}
  catch(e){console.error('DRAW HSSP stop error:',e);}
  dessinPlaying=false;
}

/* Le plafond de hauteur a changé : reconstruire et rejouer la courbe (mise à l'échelle). */
async function dessinReapplyMaxHeight(){
  if(!dessinCurve)return;
  await dessinStopPlayback();
  var playTime=await dessinStartPlayback();
  dessinStartTime=playTime||Date.now();
  dessinApplyCurve(dessinCurve,dessinStartTime,dessinPeriodMs);
  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'dessin_init',points:dessinCurve,startTime:dessinStartTime,periodMs:dessinPeriodMs}));
  }
}

/* ── Launch (controller) ── */
async function dessinLaunch(){
  if(!dessinCurve||dessinLaunching)return;
  document.getElementById('dessinSetup').classList.remove('active');
  document.getElementById('dessinOverlay').classList.add('active','is-ctrl');
  document.getElementById('dessinHud').classList.add('show');

  var playTime=await dessinStartPlayback();
  dessinStartTime=playTime||Date.now();
  dessinApplyCurve(dessinCurve,dessinStartTime,dessinPeriodMs);
  dessinStartPlayhead();
  dessinStartLabelTimer();

  if(gameDataConn&&gameDataConn.open){
    gameDataConn.send(JSON.stringify({type:'dessin_init',points:dessinCurve,startTime:dessinStartTime,periodMs:dessinPeriodMs}));
  }
}

/* ── Passive start (received via PeerJS) ── */
function dessinPassiveStart(msg){
  dessinActive=true;dessinIsCtrl=false;
  document.getElementById('dessinOverlay').classList.add('active');
  document.getElementById('dessinOverlay').classList.remove('is-ctrl');
  document.getElementById('dessinHud').classList.remove('show');
  dessinApplyCurve(msg.points,msg.startTime,msg.periodMs);
  dessinStartPlayhead();
  document.getElementById('passiveSpeedHud').classList.add('show');
  dessinStartLabelTimer();
}

/* ── Passive stop (received via PeerJS) ── */
function dessinPassiveStop(){
  dessinActive=false;
  dessinStopPlayhead();
  if(dessinLabelTimer){clearInterval(dessinLabelTimer);dessinLabelTimer=null;}
  document.getElementById('dessinOverlay').classList.remove('active','is-ctrl');
  document.getElementById('dessinHud').classList.remove('show');
  document.getElementById('passiveSpeedHud').classList.remove('show');
}

/* ── Shared render (ctrl + passive) ── */
function dessinApplyCurve(points,startTime,periodMs){
  dessinCurve=points;dessinStartTime=startTime;dessinPeriodMs=periodMs;
  var pts=[];
  for(var i=0;i<points.length;i++){
    var x=(i/(points.length-1))*100;
    var y=30-(points[i]/100)*30;
    pts.push(x.toFixed(1)+','+y.toFixed(1));
  }
  document.getElementById('dessinWavePath').setAttribute('points',pts.join(' '));
  document.getElementById('dessinWaveLabel').textContent='✏️ Your curve — '+(periodMs/1000).toFixed(1)+'s';
}

function dessinStartPlayhead(){
  dessinStopPlayhead();
  var dot=document.getElementById('dessinDot');
  function tick(){
    if(!dessinActive)return;
    var progress=((Date.now()-dessinStartTime)%dessinPeriodMs)/dessinPeriodMs;
    var pos=dessinSampleCurve(progress); // 0..100
    dot.style.left=(progress*100)+'%';
    dot.style.top=(100-pos)+'%';
    dessinRaf=requestAnimationFrame(tick);
  }
  dessinRaf=requestAnimationFrame(tick);
}
function dessinStopPlayhead(){if(dessinRaf){cancelAnimationFrame(dessinRaf);dessinRaf=null;}}

/* ── Position HUD (controller + passive) ── */
function dessinStartLabelTimer(){
  if(dessinLabelTimer){clearInterval(dessinLabelTimer);dessinLabelTimer=null;}
  dessinUpdateLabel();
  dessinLabelTimer=setInterval(dessinUpdateLabel,300);
}
function dessinUpdateLabel(){
  var progress=((Date.now()-dessinStartTime)%dessinPeriodMs)/dessinPeriodMs;
  var pos=Math.round(dessinSampleCurve(progress));
  if(dessinIsCtrl){
    document.getElementById('dessinSpeedLabel').textContent=dessinPlaying?'Position: '+pos+'%':'Position: pause';
  }else{
    document.getElementById('passiveSpeedHud').textContent='Position: '+pos+'%';
  }
}

/* ── Stop ── */
async function stopDessinMode(){
  dessinActive=false;
  dessinStopRecording();
  dessinStopPlayhead();
  if(dessinLabelTimer){clearInterval(dessinLabelTimer);dessinLabelTimer=null;}
  document.getElementById('dessinOverlay').classList.remove('active','is-ctrl');
  document.getElementById('dessinHud').classList.remove('show');
  document.getElementById('dessinSetup').classList.remove('active');
  document.getElementById('passiveSpeedHud').classList.remove('show');

  if(dessinIsCtrl){
    if(gameDataConn&&gameDataConn.open){
      gameDataConn.send(JSON.stringify({type:'dessin_stop'}));
    }
    await dessinStopPlayback();
    dessinIsCtrl=false;
    document.getElementById('gameModeSelect').classList.add('active');
  }
}
