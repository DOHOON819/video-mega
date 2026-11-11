'use strict';
const $ = id => document.getElementById(id);
const local = ['127.0.0.1','localhost'].includes(location.hostname);
function stored(key){try{return localStorage.getItem(key);}catch{return null;}}
const state = {base: local ? location.origin : (stored('fw-server') || 'http://127.0.0.1:8791'), token:'', style:'cinematic', referenceId:'', job:null, health:null, shown:12, timer:null, dirty:new Map(), busy:false};
state.token = stored('fw-token') || '';
let toastTimer, introTimer, introBlob;
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,6500); }
function element(tag,cls,text) { const node=document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=text; return node; }
function timecode(seconds) { const n=Math.round(seconds); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
async function api(path, body) {
  const response=await fetch(state.base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Frameweave-Key':state.token},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const data=await response.json(); if(!response.ok)throw new Error(data.error||'작업실과 통신하지 못했습니다.'); return data;
}
function showView(id) {
  document.querySelectorAll('.view').forEach(n=>n.hidden=n.id!==id);
  document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.view===id));
  const labels={studio:'영상 작업실',library:'내 프로젝트',settings:'엔진 연결'};
  $('breadcrumb').replaceChildren(document.createTextNode('워크스페이스 '),element('i','', '/'),element('strong','',labels[id]));
  if(id==='library') loadProjects();
  if(id==='settings') refreshHealth();
}
function counts() { const total=+$('duration').value,clip=+$('clip-duration').value; $('scene-count').textContent=`${Math.ceil((total-6)/clip).toLocaleString()}개 장면 + 인트로`; $('total-label').textContent=`총 ${timecode(total)}`; }
function brief(action) { return {topic:$('topic').value,description:$('description').value,duration:+$('duration').value,clip_duration:+$('clip-duration').value,style:state.style,model:$('model').value,reference_id:state.referenceId,reference_name:$('reference-name').value.trim(),action}; }
function setReference(referenceId,preview=''){
  state.referenceId=referenceId||'';
  const image=$('reference-preview');
  if(state.referenceId){image.src=preview||`${state.base}/user-reference/${state.referenceId}.png`;image.hidden=false;$('reference-empty').hidden=true;$('reference-clear').hidden=false;$('reference-status').textContent='기준 이미지 준비 완료 · 장면 사이 인물과 화면을 이어갑니다.';}
  else{image.removeAttribute('src');image.hidden=true;$('reference-empty').hidden=false;$('reference-clear').hidden=true;$('reference-status').textContent='PNG · JPG · WEBP, 최대 7MB';}
  saveDraft();
}
async function uploadReference(file){
  if(!file)return;
  if(file.size>7_000_000)throw new Error('기준 이미지는 7MB 이하로 선택해 주세요.');
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('PNG, JPG 또는 WEBP 이미지를 선택해 주세요.');
  $('reference-status').textContent='이미지를 안전하게 준비하고 있어요…';
  const imageData=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('이미지를 읽지 못했습니다.'));reader.readAsDataURL(file);});
  const saved=await api('/api/references',{image_data:imageData});setReference(saved.id,state.base+saved.preview);toast('이 이미지를 영상의 기준 인물로 사용합니다.');
}
function setBusy(value) { state.busy=value; }
function setSubmitting(value) {
  state.submitting=value;
  $('plan-button').disabled=value;$('auto-button').disabled=value;
  $('auto-button').textContent=value?'연결 확인 및 작업 접수 중…':'이 내용으로 새 영상 만들기 →';
}
async function start(action) {
  if(state.submitting)return;
  if(!$('brief-form').reportValidity())return;
  setSubmitting(true);
  try {
    await initialized;
    if(!state.token)throw new Error('로컬 작업실에 연결해 주세요. 엔진 연결 화면에서 연결할 수 있어요.');
    const health=await refreshHealth();
    if(!health)throw new Error('로컬 작업실에 연결하지 못했습니다. 엔진 연결에서 다시 확인해 주세요.');
    if(+$('clip-duration').value===4&&!health.capabilities?.clip_durations?.includes(4))throw new Error('현재 연결된 로컬 작업실은 4초 장면을 아직 지원하지 않습니다. 작업실 업데이트가 적용된 뒤 다시 시도하거나 다른 장면 길이를 선택해 주세요. 입력한 내용은 그대로 보관됩니다.');
    if(!health.ollama.ready)throw new Error('장면 구성을 위해 Ollama를 실행해 주세요.');
    if(action==='auto'&&!health.comfy.ready)throw new Error(health.comfy.model_ready?'새 영상 AI의 실제 결과를 검증하고 있습니다. 검증이 끝나면 생성할 수 있어요.':health.comfy.running?'영상 엔진의 모델 준비가 끝나지 않았습니다. 엔진 연결에서 준비 상태를 확인해 주세요.':'영상 엔진이 꺼져 있습니다. Video Mega 시작 프로그램을 실행한 뒤 다시 눌러 주세요.');
    const job=await api('/api/jobs',brief(action)); state.dirty.clear();state.shown=12;setJob(job);$('storyboard').scrollIntoView({behavior:'smooth',block:'start'});poll();loadProjects();
  }
  catch(error){toast(error.message);}
  finally{setSubmitting(false);}
}
function setJob(job) {
  const changed=state.job?.id!==job.id;
  if(changed){state.dirty.clear();state.shown=12;}
  if(changed||(state.job?.output&&!job.output))resetPreview();
  state.job=job; localStorage.setItem('fw-job',job.id);
  if(typeof history!=='undefined'&&location.protocol!=='file:'){
    const params=new URLSearchParams(location.search||'');params.set('project',job.id);
    history.replaceState(null,'',`${location.pathname||'/'}?${params}`);
  }
  $('current-project').hidden=false;
  $('current-project-kind').textContent=job.recovery?'원래 프로젝트':'현재 프로젝트';
  $('current-project-title').textContent=job.brief.topic;
  $('current-project-summary').textContent=`장면 구성 ${(job.scenes?.length||0).toLocaleString()}개 · 영상 생성 ${(job.completed_scenes||0).toLocaleString()} / ${job.total_scenes.toLocaleString()}개`;
  $('character-card').hidden=!job.character;
  if(job.character){
    $('character-name').textContent=job.character.name;
    $('character-photo').src=job.character.preview?state.base+job.character.preview:state.base+'/characters/jang-seokwon-official.png';
    $('character-source').hidden=!job.character.source;
    if(job.character.source)$('character-source').href=job.character.source;
  }
  $('job-progress').hidden=false;$('job-status').textContent=job.phase||'작업 준비 중';$('job-detail').textContent=job.detail||'Ollama와 연결하고 있어요.';
  if(job.status==='planning'&&job.repair_scenes!==undefined){
    $('job-status').textContent='원본을 보존하며 반복 장면 수정 중';
    $('job-detail').textContent=`원본 구성 ${(job.scenes?.length||0).toLocaleString()}개 보존 · 수정안 ${job.repair_scenes.toLocaleString()} / ${(job.repair_target||job.total_scenes).toLocaleString()}개 · 생성된 영상 ${job.completed_scenes||0}개 보존`;
  }else if(job.status==='planning'){
    const chapters=job.outline_total||Math.min(job.total_scenes,Math.max(1,Math.ceil(job.brief.duration/120)));
    const outline=job.outline?.length||0;
    $('job-status').textContent=outline<chapters?'1단계 · 이야기 구간 구성 중':'2단계 · 영상 장면 구성 중';
    $('job-detail').textContent=`이야기 구간 ${outline} / ${chapters}개 · 영상 장면 ${(job.scenes?.length||0).toLocaleString()} / ${job.total_scenes.toLocaleString()}개 · 최종 영상 장면 수는 그대로입니다.`;
    if(job.planner){$('job-status').textContent=job.phase;$('job-detail').textContent+=`\n${job.planner.state==='thinking'?'AI가 이야기 흐름을 검토 중':job.planner.chars?`AI 응답 ${job.planner.chars.toLocaleString()}자 수신 중`:'AI 첫 응답 대기 중'} · ${job.detail||''}`;}
  }
  $('job-detail').classList.toggle('error-text',job.status==='error');
  if(job.status==='planning'){
    const repairing=job.repair_scenes!==undefined;
    const chapters=job.outline_total||Math.min(job.total_scenes,Math.max(1,Math.ceil(job.brief.duration/120)));
    const outline=job.outline?.length||0;
    const count=repairing?job.repair_scenes:outline<chapters?outline:(job.scenes?.length||0);
    const total=repairing?(job.repair_target||job.total_scenes):outline>=chapters?job.total_scenes:chapters;
    $('job-percent').textContent=`${count.toLocaleString()} / ${total.toLocaleString()} ${!repairing&&outline<chapters?'구간':'장면'}`;
    $('job-bar').value=count/total*100;
    if(job.updated)$('job-detail').textContent+=`\n최근 저장 후 ${timecode(Math.max(0,Math.floor(Date.now()/1000-job.updated)))} 경과 · 다음 구성 묶음을 기다리고 있어요.`;
  }else{
    const progress=job.progress||0;
    $('job-percent').textContent=`${progress>0&&progress<1?progress.toFixed(1):Math.round(progress)}%`;$('job-bar').value=progress;
  }
  const active=['queued','planning','generating','stitching'].includes(job.status);setBusy(active);
  $('cancel-job').hidden=!active;$('resume-job').hidden=!['paused','error','cancelled'].includes(job.status);
  $('resume-job').textContent=job.status==='paused'?'계속 만들기':'이어서 시도';
  $('pause-job').hidden=job.action==='plan'||!['queued','planning','generating'].includes(job.status);
  const pauseRequested=!!(job.pause_after_scene||job.stop_after_scene);
  $('pause-job').disabled=pauseRequested;
  $('pause-job').textContent=pauseRequested?'지금 장면을 마치면 멈춰요':'지금 장면까지만 만들기';
  $('board-count').textContent=`${(job.scenes?.length||0).toLocaleString()} / ${job.total_scenes.toLocaleString()}`;$('board-description').textContent=`${job.brief.topic} · 총 ${timecode(job.brief.duration)} · 인트로 6초 포함`;
  $('export-plan').disabled=!(job.scenes?.length);$('render-button').disabled=active||!job.scenes?.length||job.status==='completed';
  $('download-video').hidden=!job.output;
  if(job.output){$('download-video').href=state.base+job.output+'?download=1';$('download-video').setAttribute('download','video-mega.mp4');showVideo(state.base+job.output,job.brief.duration);}
  renderScenes(changed);
}
function resetPreview(){
  clearInterval(introTimer);
  const player=$('player');player.pause();player.removeAttribute('src');player.load();player.hidden=true;
  $('preview-brand').hidden=false;$('preview-kind').textContent='6초 브랜드 인트로';
  $('preview-time').textContent='00:00 / 00:06';$('intro-progress').style.width='0%';
  $('preview-stage').classList.remove('playing');$('download-video').removeAttribute('href');
}
function showVideo(url,duration) { const player=$('player');if(player.getAttribute('src')!==url){player.src=url;player.load();}player.hidden=false;$('preview-brand').hidden=true;$('preview-kind').textContent='HD 완성 영상 · AI 장면 소리 포함';$('preview-time').textContent=`00:00 / ${timecode(duration)}`; }
let sceneSignature='';
function renderScenes(force=false) {
  const scenes=state.job?.scenes||[];
  const root=$('scenes');
  const signature=JSON.stringify([state.job?.id,state.busy,state.shown,scenes.slice(0,state.shown)]);
  if(!force&&signature===sceneSignature)return;
  if(!scenes.length){
    root.replaceChildren(element('p','muted',state.job?`${state.job.brief.topic}의 장면을 구성하면 이곳에 표시됩니다. 아직 완성된 장면이 없습니다.`:'이야기를 입력하면 장면이 이곳에 표시됩니다.'));
    $('more-scenes').hidden=true;return;
  }
  // Do not replace an editor while the user is typing.
  if(!force&&document.activeElement?.classList.contains('prompt-editor'))return;
  sceneSignature=signature;
  root.replaceChildren();
  for(const scene of scenes.slice(0,state.shown)) {
    const card=element('article','scene'),art=element('div','scene-art');
    if(/^(characters|environments)\/[a-z0-9-]+\.png$/.test(scene.reference_asset||'')){
      const image=element('img','scene-thumb');image.src=`${state.base}/reference-preview/${scene.reference_asset}`;image.alt=`${scene.index}번 장면 기준 이미지`;art.classList.add('has-image');art.append(image);
    }
    art.append(element('b','',String(scene.index).padStart(2,'0')),element('small','',`${scene.duration}초`));
    if(scene.status==='done')card.classList.add('is-done');
    const body=element('div','scene-body');body.append(element('div','scene-number',`${timecode(scene.start)} · ${scene.status==='done'?'생성 완료':scene.status==='generating'?'생성 중':'장면 구성'}`),element('h3','',scene.title),element('p','',scene.visual),element('div','scene-audio','♫ '+scene.audio));
    if(scene.continuity_from)body.append(element('span','continuity-chip',`↳ ${scene.continuity_from}번 영상의 끝 프레임에서 시작`));
    if(scene.dialogue){body.append(element('blockquote','scene-dialogue',`${scene.dialogue.speaker} · “${scene.dialogue.text}”`));}
    if(scene.status==='done'){
      const take=state.job.takes?.[scene.take_id];
      const clip=element('button','button subtle clip-link',take?'▶ 이어지는 대사 보기':'▶ 생성된 영상 보기');
      clip.addEventListener('click',()=>{showVideo(take?state.base+take.output:`${state.base}/media/${state.job.id}/raw-${String(scene.index).padStart(4,'0')}.mp4`,take?.duration||scene.duration);$('preview-kind').textContent=take?`${take.members[0]}–${take.members.at(-1)}번째 장면 · 이어지는 대사`:`${scene.index}번째 장면 · ${scene.title}`;$('preview-stage').scrollIntoView({behavior:'smooth',block:'center'});});body.append(clip);
      const canRetry=scene.index===(state.job.completed_scenes||0)&&!state.busy;
      if(canRetry){const retry=element('button','button subtle','↻ 이 장면 다시 만들기');retry.addEventListener('click',()=>retryScene(scene.index));body.append(retry);}
    }
    const details=element('details');details.append(element('summary','','생성 프롬프트'));
    const editor=element('textarea','prompt-editor');editor.value=state.dirty.get(scene.index)||scene.prompt;editor.maxLength=3000;editor.setAttribute('aria-label',`${scene.index}번 장면 생성 프롬프트`);editor.disabled=state.busy||scene.status==='done';editor.addEventListener('input',()=>state.dirty.set(scene.index,editor.value));details.append(editor);body.append(details);card.append(art,body);root.append(card);
  }
  $('more-scenes').hidden=scenes.length<=state.shown;$('more-scenes').textContent=`장면 더 보기 (${Math.min(state.shown,scenes.length)} / ${scenes.length})`;
}
async function poll() {
  clearTimeout(state.timer);if(!state.job)return;
  const id=state.job.id;
  try { const job=await api('/api/jobs/'+id);if(state.job?.id!==id)return;setJob(job);if(['queued','planning','generating','stitching'].includes(job.status))state.timer=setTimeout(poll,3000);else loadProjects(); }
  catch(error){if(state.job?.id!==id)return;$('job-detail').textContent='작업실 연결을 다시 확인하고 있어요. 생성 작업은 PC에서 계속 진행됩니다.';state.timer=setTimeout(poll,6000);}
}
async function saveSceneEdits(){if(!state.dirty.size)return;await api(`/api/jobs/${state.job.id}/scenes`,{changes:[...state.dirty].map(([index,prompt])=>({index,prompt}))});state.dirty.clear();}
async function render(){if(!state.job)return;try{await saveSceneEdits();const job=await api(`/api/jobs/${state.job.id}/render`,{});setJob(job);poll();}catch(error){toast(error.message);}}
async function retryScene(index){
  try{
    const result=await api(`/api/jobs/${state.job.id}/retry`,{index,reason:'user quality review'});
    setJob(result.job);toast(`${index}번째 원본을 백업하고 다시 만들기 시작했어요.`);
    setJob(await api(`/api/jobs/${state.job.id}/resume`,{one_scene:true}));poll();
  }catch(error){toast(error.message);}
}
async function loadProjects(){
  if(!state.token){$('project-list').replaceChildren(element('p','muted','작업실에 연결하면 프로젝트가 나타나요.'));return;}
  try{const {jobs}=await api('/api/jobs');$('project-count').textContent=String(jobs.length);const root=$('project-list');root.replaceChildren();if(!jobs.length){root.append(element('p','muted','아직 프로젝트가 없어요. 첫 이야기를 만들어 보세요.'));return [];}
    const statuses={queued:'대기 중',planning:'장면 구성 중',ready:'장면 구성 완료',generating:'영상 생성 중',stitching:'이어 붙이는 중',completed:'완성',error:'확인 필요',paused:'이어 만들기',cancelled:'중지됨'};
    for(const job of jobs){const card=element('button','panel project');card.append(element('small','',statuses[job.status]||job.status),element('h3','',job.brief.topic),element('p','',`${timecode(job.brief.duration)} · ${job.total_scenes}개 장면 · 영상 ${job.completed_scenes||0}개 생성`),element('small','',new Date(job.created*1000).toLocaleDateString('ko-KR')));card.addEventListener('click',async()=>{try{const full=await api('/api/jobs/'+job.id);state.dirty.clear();state.shown=12;setJob(full);fillBrief(full.brief);showView('studio');poll();$('storyboard').scrollIntoView({behavior:'smooth'});}catch(e){toast(e.message);}});root.append(card);}
    return jobs;
  }catch(error){$('project-list').replaceChildren(element('p','muted',error.message));}
}
async function refreshHealth(){
  $('refresh-health').disabled=true;
  try{
    const h=await api('/api/health');state.health=h;const ready=h.ollama.ready&&h.comfy.ready;
    $('clip-duration-four').hidden=$('clip-duration-four').disabled=!h.capabilities?.clip_durations?.includes(4);
    $('engine-preview').hidden=!h.comfy.preview;
    $('connection-pill').textContent=ready?'● 로컬 엔진 준비 완료':'● 로컬 작업실 연결됨';$('connection-pill').classList.add('connected');
    $('engine-note').textContent=ready?'Ollama와 영상 엔진이 연결됐어요. 먼저 15초 영상으로 시작해 보세요.':h.ollama.ready?'Ollama 연결 완료. 영상 엔진은 준비 중이며, 장면 구성부터 시작할 수 있어요.':'장면 구성을 위해 Ollama를 실행해 주세요.';
    $('reference-name-field').hidden=!h.capabilities?.reference_speaker_names;
    const rows=[['Ollama · 장면 구성',h.ollama.ready?'연결됨':'실행 필요',h.ollama.ready],[h.comfy.name||'영상과 소리 AI',h.comfy.ready?'준비 완료':h.comfy.model_ready?'실제 영상 검증 중':h.comfy.running?'모델·노드 준비 중':'실행 필요',h.comfy.ready],['FFmpeg · 이어 붙이기',h.ffmpeg.ready?'준비 완료':'설치 필요',h.ffmpeg.ready],['저장 공간',`${h.storage_free_gb.toLocaleString()} GB 여유`,h.storage_free_gb>10]];
    const characterEngine=document.querySelector?.('#character-card small');if(characterEngine)characterEngine.textContent=`IDENTITY LOCK · ${h.comfy.name||'영상 AI'} · NATIVE AUDIO`;
    const facts=document.querySelector?.('.facts p');if(facts)facts.textContent=`Video Mega는 장면 구성에 Ollama, 영상과 소리 생성에 ${h.comfy.name||'로컬 영상 AI'}를 사용합니다. 크레딧이나 생성 횟수 제한 없이 계속 만들 수 있으며 PC·저장 공간·전력만 사용합니다. 별도의 유료 API로 자동 전환하지 않습니다.`;
    $('health-list').replaceChildren(...rows.map(([label,value,ready])=>{const row=element('div','health-item');row.append(element('span','',label),element('span',ready?'ok':'warn',value));return row;}));
    const old=$('model').value;if(h.ollama.models.length){$('model').replaceChildren(...h.ollama.models.map(name=>{const op=element('option','',name);op.value=name;return op;}));$('model').value=h.ollama.models.includes(old)?old:h.ollama.models.includes('qwen2.5:3b')?'qwen2.5:3b':h.ollama.models[0];}
    return h;
  }catch(error){state.health=null;$('connection-pill').textContent='○ 로컬 작업실 연결 필요';$('connection-pill').classList.remove('connected');$('health-list').replaceChildren(element('p','muted','로컬 작업실이 실행 중인지 확인해 주세요. 웹에서 연결이 차단되면 로컬 작업실 열기를 이용해 주세요.'));$('engine-note').textContent='로컬 작업실을 실행하고 엔진 연결을 설정하면 AI 영상 제작을 시작할 수 있어요.';}
  finally{$('refresh-health').disabled=false;}
}
async function reconnectStudio(){
  if(location.protocol==='file:')return;
  try{
    if(local&&!state.token){
      const response=await fetch('/api/session',{signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error('Local studio is starting');
      const session=await response.json();state.token=session.token;
      localStorage.setItem('fw-token',state.token);$('pair-code').value=state.token;
    }
    const wasOffline=!state.health;
    const health=await refreshHealth();
    if(health&&wasOffline){
      const jobs=await loadProjects()||[];
      if(!state.job&&!state.submitting){
        const id=chooseProject(jobs,stored('fw-job'),new URLSearchParams(location.search||'').get('project'));
        if(id){const job=await api('/api/jobs/'+id);if(!state.job){setJob(job);poll();}}
      }
    }
  }catch{}
  finally{setTimeout(reconnectStudio,state.health?.comfy.ready?30000:8000);}
}
function downloadJSON(){if(!state.job)return;const exported=structuredClone(state.job);for(const s of exported.scenes)if(state.dirty.has(s.index))s.prompt=state.dirty.get(s.index);const blob=new Blob([JSON.stringify(exported,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=element('a');link.href=url;link.download='video-mega-storyboard.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function playIntro(){
  if(!$('player').hidden&&$('player').getAttribute('src')){$('player').play().catch(()=>{});return;}
  if(state.job?.output){$('player').play().catch(()=>{});return;}
  if(state.token){try{if(!introBlob){const res=await fetch(state.base+'/api/intro',{headers:{'X-Frameweave-Key':state.token}});if(!res.ok)throw new Error();introBlob=URL.createObjectURL(await res.blob());}$('player').src=introBlob;$('player').hidden=false;$('preview-brand').hidden=true;await $('player').play();return;}catch{}}
  $('player').hidden=true;$('preview-brand').hidden=false;$('preview-stage').classList.remove('playing');void $('preview-stage').offsetWidth;$('preview-stage').classList.add('playing');clearInterval(introTimer);const start=performance.now();introTimer=setInterval(()=>{const elapsed=Math.min(6,(performance.now()-start)/1000);$('intro-progress').style.width=`${elapsed/6*100}%`;$('preview-time').textContent=`${timecode(elapsed)} / 00:06`;if(elapsed>=6){clearInterval(introTimer);$('preview-stage').classList.remove('playing');}},40);
}
document.querySelectorAll('[data-view]').forEach(n=>n.addEventListener('click',()=>showView(n.dataset.view)));
document.querySelectorAll('[data-open-settings]').forEach(n=>n.addEventListener('click',()=>showView('settings')));
$('avatar').addEventListener('click',()=>showView('settings'));
$('brief-form').addEventListener('submit',e=>{e.preventDefault();start('auto');});$('plan-button').addEventListener('click',()=>start('plan'));
$('description').addEventListener('input',()=>{$('char-count').textContent=`${$('description').value.length.toLocaleString()} / 4,000`;saveDraft();});
function saveDraft(){localStorage.setItem('fw-draft',JSON.stringify(brief('plan')));}
for(const id of ['topic','duration','clip-duration','reference-name'])$(id).addEventListener('change',()=>{counts();saveDraft();});
document.querySelectorAll('[data-style]').forEach(n=>n.addEventListener('click',()=>{state.style=n.dataset.style;document.querySelectorAll('[data-style]').forEach(b=>b.classList.toggle('selected',b===n));saveDraft();}));
$('example').addEventListener('click',()=>{$('topic').value='빗소리와 함께 걷는 새벽의 숲';$('description').value='이슬이 맺힌 나뭇잎에서 시작해, 작은 개울을 지나 안개 낀 숲길로 걸어갑니다. 부드러운 아침빛과 차분한 초록색. 빗방울, 새소리, 흐르는 물소리가 장면에 맞게 들리는 힐링 영상.';$('duration').value='15';$('description').dispatchEvent(new Event('input'));counts();saveDraft();toast('15초 테스트 예시를 준비했어요. 장면 구성하기를 눌러 시작하세요.');});
$('more-scenes').addEventListener('click',()=>{state.shown+=24;renderScenes();});$('export-plan').addEventListener('click',downloadJSON);$('render-button').addEventListener('click',render);
$('reference-select').addEventListener('click',()=>$('reference-file').click());
$('reference-file').addEventListener('change',async event=>{try{await uploadReference(event.target.files?.[0]);}catch(error){toast(error.message);$('reference-status').textContent='이미지를 준비하지 못했습니다. 다른 파일을 선택해 주세요.';}finally{event.target.value='';}});
$('reference-clear').addEventListener('click',()=>setReference(''));
$('cancel-job').addEventListener('click',async()=>{try{await api(`/api/jobs/${state.job.id}/cancel`,{});toast('중지를 요청했어요. 현재 요청을 정리한 뒤 멈춥니다.');}catch(e){toast(e.message);}});
$('pause-job').addEventListener('click',async()=>{try{setJob(await api(`/api/jobs/${state.job.id}/pause`,{}));toast('만들고 있는 장면을 저장한 뒤 멈춥니다.');}catch(e){toast(e.message);}});
$('resume-job').addEventListener('click',async()=>{try{await saveSceneEdits();const changed=Boolean(state.health?.comfy?.engine&&state.job.engine!==state.health.comfy.engine);setJob(await api(`/api/jobs/${state.job.id}/resume`,{replan_unfinished:changed}));poll();}catch(e){toast(e.message);}});
$('new-project').addEventListener('click',()=>{showView('studio');$('topic').focus();window.scrollTo({top:0,behavior:'smooth'});});
$('play-intro').addEventListener('click',playIntro);$('refresh-health').addEventListener('click',refreshHealth);
$('engine-preview').addEventListener('click',()=>{if(state.health?.comfy.preview){showVideo(state.base+state.health.comfy.preview,state.health.comfy.preview_duration||3);$('preview-kind').textContent=state.health.comfy.preview_label||`새 AI 시험영상 · ${state.health.comfy.name||'영상 AI'}`;$('preview-stage').scrollIntoView({behavior:'smooth',block:'center'});}});
$('current-project').addEventListener('click',()=>$('storyboard').scrollIntoView({behavior:'smooth',block:'start'}));
$('save-connection').addEventListener('click',async()=>{try{const url=new URL($('server-url').value);if(!['127.0.0.1','localhost'].includes(url.hostname)||url.protocol!=='http:')throw new Error('이 PC의 http://127.0.0.1 주소를 사용해 주세요.');state.base=url.origin;state.token=$('pair-code').value.trim();localStorage.setItem('fw-server',state.base);localStorage.setItem('fw-token',state.token);await api('/api/jobs');await refreshHealth();toast('작업실에 연결했어요.');loadProjects();}catch(e){toast(e.message);}});
async function init(){
  // A file:// document has an opaque origin and cannot pair with the server.
  // Open this same UI on loopback; transfer only the draft, never credentials.
  if(location.protocol==='file:'){
    let fragment='';
    try{const draft=readDraft(localStorage.getItem('fw-draft'));if(draft)fragment='#draft='+encodeURIComponent(JSON.stringify(draft));}catch{}
    location.replace('http://127.0.0.1:8791/'+fragment);
    return;
  }
  if(local&&location.hash.startsWith('#draft=')){
    try{const draft=readDraft(decodeURIComponent(location.hash.slice(7)));if(draft)localStorage.setItem('fw-draft',JSON.stringify(draft));}catch{}
    history.replaceState(null,'',location.pathname+location.search);
  }
  try{const draft=JSON.parse(localStorage.getItem('fw-draft')||'null');if(draft){$('topic').value=draft.topic||'';$('description').value=draft.description||'';$('duration').value=String(draft.duration);$('clip-duration').value=String(draft.clip_duration);state.style=draft.style||'cinematic';state.referenceId=/^[a-f0-9]{64}$/.test(draft.reference_id||'')?draft.reference_id:'';$('reference-name').value=String(draft.reference_name||'').slice(0,40);document.querySelectorAll('[data-style]').forEach(n=>n.classList.toggle('selected',n.dataset.style===state.style));$('char-count').textContent=`${$('description').value.length.toLocaleString()} / 4,000`;}}catch{}
  counts();$('server-url').value=state.base;
  if(local){try{const session=await fetch('/api/session').then(r=>r.json());state.token=session.token;localStorage.setItem('fw-token',state.token);$('local-code').hidden=false;$('local-code').textContent='웹 작업실 연결 코드: '+state.token;}catch{}}
  if(state.referenceId)setReference(state.referenceId);
  $('pair-code').value=state.token;await refreshHealth();const jobs=await loadProjects()||[];
  const requested=new URLSearchParams(location.search||'').get('project');
  const id=chooseProject(jobs,stored('fw-job'),requested);
  if(id&&state.token){try{const job=await api('/api/jobs/'+id);setJob(job);fillBrief(job.brief);poll();}catch(error){toast(error.message);}}
  setTimeout(reconnectStudio,8000);
}
function chooseProject(jobs,saved,requested){
  return jobs.find(job=>job.id===requested)?.id||jobs.find(job=>job.id===saved)?.id||jobs[0]?.id;
}
function fillBrief(value){
  $('topic').value=value.topic;$('description').value=value.description;
  $('duration').value=String(value.duration);$('clip-duration').value=String(value.clip_duration);
  state.style=value.style||'cinematic';
  $('reference-name').value=value.reference_name||'';
  setReference(value.reference_id||'');
  document.querySelectorAll('[data-style]').forEach(n=>n.classList.toggle('selected',n.dataset.style===state.style));
  $('char-count').textContent=`${value.description.length.toLocaleString()} / 4,000`;counts();saveDraft();
}
function readDraft(raw){
  const draft=JSON.parse(raw||'null');
  if(!draft||typeof draft.topic!=='string'||typeof draft.description!=='string')return null;
  return {topic:draft.topic.slice(0,160),description:draft.description.slice(0,4000),
    duration:[15,60,600,1800,3600].includes(+draft.duration)?+draft.duration:15,
    clip_duration:[3,4,5,6,8].includes(+draft.clip_duration)?+draft.clip_duration:3,
    style:['cinematic','nature','animation'].includes(draft.style)?draft.style:'cinematic',
    reference_id:/^[a-f0-9]{64}$/.test(draft.reference_id||'')?draft.reference_id:'',reference_name:String(draft.reference_name||'').slice(0,40)};
}
const initialized=init();
