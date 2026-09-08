(function (global) {
  'use strict';
  var KEY='miya-tauri-tools-v2';
  var state={regex:[]};
  var modal=null;
  function load(){try{var x=JSON.parse(localStorage.getItem(KEY)||'{}');if(x&&typeof x==='object')state=Object.assign(state,x);}catch(e){}}
  function save(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function toast(t){if(global.miyaChatApp&&global.miyaChatApp.toast)global.miyaChatApp.toast(t);}
  function chatId(){return global.miyaChatRoom&&global.miyaChatRoom.getOpenChatId?String(global.miyaChatRoom.getOpenChatId()||''):'';}
  function store(){return global.miyaChatStore;}
  function messages(){var s=store(),id=chatId();return s&&id&&s.getMessages?s.getMessages(id):[];}
  function ensureModal(){
    if(modal)return modal;
    modal=document.createElement('div');modal.className='mtf-modal';modal.hidden=true;
    modal.innerHTML='<div class="mtf-card"><header><div><small>TAURITAVERN TOOLS</small><h2>聊天增强工具</h2></div><button data-mtf-close>×</button></header><div class="mtf-tabs"><button data-mtf-tab="search">搜索</button><button data-mtf-tab="backup">备份</button><button data-mtf-tab="regex">正则</button></div><section data-mtf-pane="search"></section><section data-mtf-pane="backup" hidden></section><section data-mtf-pane="regex" hidden></section></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click',onModalClick);
    modal.querySelectorAll('[data-mtf-tab]').forEach(function(b){b.addEventListener('click',function(){showPane(b.dataset.mtfTab);});});
    return modal;
  }
  function open(){ensureModal();renderAll();modal.hidden=false;document.body.classList.add('mtf-open');}
  function close(){if(modal){modal.hidden=true;document.body.classList.remove('mtf-open');}}
  function showPane(name){ensureModal().querySelectorAll('[data-mtf-pane]').forEach(function(p){p.hidden=p.dataset.mtfPane!==name;});}
  function renderAll(){
    var m=ensureModal();
    m.querySelector('[data-mtf-pane="search"]').innerHTML='<div class="mtf-row"><input id="mtf-search" placeholder="搜索当前聊天消息…"><button data-mtf-act="search">搜索</button></div><div id="mtf-search-results" class="mtf-results"></div>';
    m.querySelector('[data-mtf-pane="backup"]').innerHTML='<p class="mtf-note">备份当前会话的完整消息数据，可在本设备恢复。</p><div class="mtf-actions"><button data-mtf-act="export">导出聊天备份</button><button data-mtf-act="import">导入聊天备份</button><input id="mtf-file" type="file" accept="application/json,.json" hidden></div>';
    m.querySelector('[data-mtf-pane="regex"]').innerHTML='<div class="mtf-form"><input id="mtf-r-name" placeholder="规则名称"><input id="mtf-r-find" placeholder="查找正则，例如 ^\\s+"><input id="mtf-r-repl" placeholder="替换内容"><label><input id="mtf-r-in" type="checkbox" checked> 作用于 AI 回复</label><label><input id="mtf-r-out" type="checkbox"> 作用于用户发送</label><button data-mtf-act="addregex">添加规则</button></div><div id="mtf-regex-list"></div>';
    var fi=m.querySelector('#mtf-file');if(fi)fi.onchange=function(){if(this.files[0])importChat(this.files[0]);this.value='';};
    renderRegex();
  }
  function renderRegex(){var box=modal.querySelector('#mtf-regex-list');box.innerHTML=(state.regex||[]).map(function(r,i){return '<div class="mtf-result"><b>'+esc(r.name||('规则 '+(i+1)))+'</b><code>/'+esc(r.find)+'/</code><span>→ '+esc(r.repl||'')+'</span><small>来源：'+esc(r.source||'本地规则')+'</small><button data-mtf-delregex="'+i+'">删除</button></div>';}).join('')||'<div class="mtf-empty">暂无本地正则规则。预设/角色提供的正则会与本地规则一起执行。</div>';}
  function onModalClick(e){var t=e.target;if(t.matches('[data-mtf-close]'))return close();var a=t.getAttribute('data-mtf-act');if(a==='search')return doSearch();if(a==='export')return exportChat();if(a==='import')return modal.querySelector('#mtf-file').click();if(a==='addregex')return addRegex();var d=t.getAttribute('data-mtf-delregex');if(d!=null){state.regex.splice(Number(d),1);save();renderRegex();}}
  function doSearch(){var q=String(modal.querySelector('#mtf-search').value||'').trim().toLowerCase(),box=modal.querySelector('#mtf-search-results');var rows=messages().filter(function(m){return q&&String(m.content||'').toLowerCase().indexOf(q)>=0;}).slice(-100).reverse();box.innerHTML=rows.map(function(m){return '<div class="mtf-result"><b>'+esc(m.role==='user'?'我':'AI')+'</b><span>'+esc(String(m.content||'').slice(0,260))+'</span></div>';}).join('')||'<div class="mtf-empty">没有找到匹配消息。</div>';}
  function exportChat(){var id=chatId(),s=store(),row=s&&s.findChat?s.findChat(id):null,data={version:1,exportedAt:new Date().toISOString(),chat:row,messages:messages()};var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='miya-chat-'+(id||'backup')+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},1000);}
  function importChat(file){var fr=new FileReader();fr.onload=function(){try{var d=JSON.parse(fr.result),id=chatId(),s=store();if(!id||!d||!Array.isArray(d.messages)||!s||!s.importChatMessages)throw Error('invalid');s.importChatMessages(id,d.messages).then(function(){toast('聊天备份已恢复');location.reload();});}catch(e){toast('备份格式无效或当前版本不支持恢复');}};fr.readAsText(file);}
  function addRegex(){var f=modal.querySelector('#mtf-r-find').value.trim();if(!f)return toast('请输入正则');try{new RegExp(f);}catch(e){return toast('正则语法错误');}state.regex.push({name:modal.querySelector('#mtf-r-name').value.trim()||'未命名规则',find:f,repl:modal.querySelector('#mtf-r-repl').value||'',incoming:modal.querySelector('#mtf-r-in').checked,outgoing:modal.querySelector('#mtf-r-out').checked,source:'本地规则'});save();renderRegex();}
  function applyRegex(text,dir){var s=String(text==null?'':text);(state.regex||[]).forEach(function(r){if((dir==='incoming'&&!r.incoming)||(dir==='outgoing'&&!r.outgoing))return;try{s=s.replace(new RegExp(r.find,'g'),r.repl||'');}catch(e){}});return s;}
  function getExternalRegex(){
    var out=[];
    // 支持常见 ST/Tavern 角色/预设正则数据结构，不强制改动原数据。
    var candidates=[global.miyaChatEngine&&global.miyaChatEngine.getRegexPresets&&global.miyaChatEngine.getRegexPresets(),global.miyaChatEngine&&global.miyaChatEngine.regexPresets,global.miyaChatStore&&global.miyaChatStore.regexPresets];
    candidates.forEach(function(list){if(!Array.isArray(list))return;list.forEach(function(r){if(r&&r.findRegex)out.push(r);else if(r&&r.find)out.push(r);});});
    return out;
  }
  function applyAllRegex(text,dir){var s=String(text==null?'':text);var external=getExternalRegex();external.forEach(function(r){var find=r.findRegex||r.find,rep=r.replaceString!=null?r.replaceString:(r.repl||'');if(!find)return;try{var flags=r.flags||'g';if(flags.indexOf('g')<0)flags+='g';s=s.replace(new RegExp(find,flags),rep);}catch(e){}});return applyRegex(s,dir);}
  function stop(){var id=chatId();return global.miyaChatEngine&&global.miyaChatEngine.stopGeneration?global.miyaChatEngine.stopGeneration(id):false;}
  function syncSend(){var id=chatId(),busy=!!(global.miyaChatEngine&&global.miyaChatEngine.isReplyInFlight&&id&&global.miyaChatEngine.isReplyInFlight(id)),b=document.getElementById('qq-room-send');if(!b)return;b.classList.toggle('mtf-stop',busy);b.setAttribute('aria-label',busy?'停止生成':'发送');b.title=busy?'停止生成':'发送';var svg=b.querySelector('svg');if(busy){if(!b.dataset.mtfOrig&&svg)b.dataset.mtfOrig=svg.outerHTML;if(svg)svg.outerHTML='<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';}else if(b.dataset.mtfOrig&&svg){svg.outerHTML=b.dataset.mtfOrig;delete b.dataset.mtfOrig;}}
  function enhanceInput(){var input=document.getElementById('qq-room-input'),box=input&&input.parentElement;if(!input||!box||box.querySelector('.mtf-expand'))return;var b=document.createElement('button');b.type='button';b.className='mtf-expand';b.title='全屏编辑';b.textContent='↗';b.onclick=function(){var v=input.value,x=prompt('全屏编辑消息',v);if(x!==null){input.value=x;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}};box.insertBefore(b,input);}
  function addToolbarButton(){var b=document.getElementById('qq-room-more');if(!b||b.parentElement.querySelector('.mtf-tools'))return;var n=document.createElement('button');n.type='button';n.className=b.className+' mtf-tools';n.title='增强工具';n.setAttribute('aria-label','增强工具');n.innerHTML='<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" fill="none" stroke="currentColor"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" fill="none" stroke="currentColor"/></svg>';n.onclick=open;b.parentElement.insertBefore(n,b);}
  function decorateSwipe(){
    var sc=document.getElementById('qq-room-scroll');if(!sc)return;
    var msgs=messages();sc.querySelectorAll('.qq-room__row[data-msg-id]').forEach(function(row){var id=row.getAttribute('data-msg-id'),m=msgs.find(function(x){return String(x.id)===String(id);});if(!m||m.role!=='assistant'||row.querySelector('.mtf-swipe-tools'))return;var floor=msgs.findIndex(function(x){return String(x.id)===String(id);})+1;var wrap=document.createElement('div');wrap.className='mtf-swipe-tools';wrap.innerHTML='<button type="button" data-mtf-swipe="prev" data-msg-id="'+esc(id)+'">‹</button><span>第 '+floor+' 层</span><button type="button" data-mtf-swipe="next" data-msg-id="'+esc(id)+'">›</button><button type="button" data-mtf-swipe="regen" data-msg-id="'+esc(id)+'">↻</button>';row.appendChild(wrap);});
  }
  function swipeAction(btn){var action=btn.getAttribute('data-mtf-swipe'),id=btn.getAttribute('data-msg-id');if(action==='regen'){if(global.miyaChatEngine&&global.miyaChatEngine.regenerateLastRound)return global.miyaChatEngine.regenerateLastRound(chatId());return;}/* 左右按钮使用当前楼层作为锚点；真正生成仍走现有离线/聊天楼层数据，不创建第二套消息存储。 */var ev=new CustomEvent('miya:swipe-floor',{detail:{chatId:chatId(),messageId:id,direction:action}});document.dispatchEvent(ev);}
  function hook(){load();setInterval(function(){addToolbarButton();enhanceInput();syncSend();decorateSwipe();},700);document.addEventListener('click',function(e){var sb=e.target.closest&&e.target.closest('#qq-room-send');if(sb&&global.MiyaTauriFeatures&&global.MiyaTauriFeatures._busy&&stop()){e.preventDefault();e.stopImmediatePropagation();}},true);document.addEventListener('click',function(e){var sw=e.target.closest&&e.target.closest('[data-mtf-swipe]');if(sw){e.preventDefault();e.stopPropagation();swipeAction(sw);}},true);var eng=global.miyaChatEngine;if(eng&&eng.sendChat&&!eng._mtfWrapped){var orig=eng.sendChat;eng.sendChat=function(id,text,opts){return orig.call(this,id,applyAllRegex(text,'outgoing'),opts);};eng._mtfWrapped=true;}var st=global.miyaChatStore;if(st&&st.addMessage&&!st._mtfWrapped){var addOrig=st.addMessage;st.addMessage=function(id,msg){var m=msg&&typeof msg==='object'?Object.assign({},msg):msg;if(m&&String(m.role||'')==='assistant'&&m.content)m.content=applyAllRegex(m.content,'incoming');return addOrig.call(this,id,m);};st._mtfWrapped=true;}}
  global.MiyaTauriFeatures={open:open,close:close,stopGeneration:stop,applyRegex:applyAllRegex,state:state,_busy:false};
  setInterval(function(){var id=chatId();global.MiyaTauriFeatures._busy=!!(global.miyaChatEngine&&global.miyaChatEngine.isReplyInFlight&&id&&global.miyaChatEngine.isReplyInFlight(id));},300);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hook);else hook();
})(window);
