(function(){
  // 文章底下的按讚、分享、留言
  var root=document.querySelector('[data-post]'); if(!root) return;
  var slug=root.getAttribute('data-post');
  var H={'content-type':'application/json','x-requested-with':'rou'};
  function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){return null;}}
  function post(path,body){return fetch(path,{method:'POST',headers:H,body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok&&j.ok,j:j};});});}

  // ---- 按讚 ----
  var likeBtn=root.querySelector('.like'), likeN=root.querySelector('.like-n');
  var visitor=store('rou-visitor');
  if(!visitor||!/^[A-Za-z0-9_-]{16,40}$/.test(visitor)){
    var a=new Uint8Array(16); (window.crypto||window.msCrypto).getRandomValues(a);
    visitor=Array.prototype.map.call(a,function(b){return ('0'+b.toString(16)).slice(-2);}).join('');
    store('rou-visitor',visitor);
  }
  var liked=store('rou-like:'+slug)==='1', count=0;
  function showLike(){likeBtn.setAttribute('aria-pressed',liked?'true':'false');likeN.textContent=count>0?String(count):'';}
  showLike();
  likeBtn.addEventListener('click',function(){
    liked=!liked; count=Math.max(0,count+(liked?1:-1)); store('rou-like:'+slug,liked?'1':'0'); showLike();
    post('/api/like',{post:slug,visitor:visitor,on:liked}).then(function(x){if(x.ok){count=x.j.likes;showLike();}}).catch(function(){});
  });

  // ---- 分享 ----
  var url=location.origin+location.pathname, title=root.getAttribute('data-title')||document.title;
  var native=root.querySelector('.share-native'), fb=root.querySelector('.share-fb');
  if(navigator.share){native.hidden=false; if(fb) fb.hidden=true;}
  native.addEventListener('click',function(){navigator.share({title:title,url:url}).catch(function(){});});
  var copyBtn=root.querySelector('.share-copy'), copyLabel=copyBtn.textContent;
  copyBtn.addEventListener('click',function(){
    function done(){copyBtn.textContent='已複製！';setTimeout(function(){copyBtn.textContent=copyLabel;},1800);}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(url).then(done,function(){prompt('複製這個連結：',url);});}
    else prompt('複製這個連結：',url);
  });

  // ---- 留言 ----
  var box=document.getElementById('comments'), list=box.querySelector('.cm-list'), empty=box.querySelector('.cm-empty'), num=box.querySelector('.cm-n');
  var teacher='柔柔老師', shown=0, tsKey='', tsWidget=null;
  function fmt(iso){var d=new Date(iso);return isNaN(d)?'':d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate();}
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function addItem(c){
    var li=el('li','cm-item'), head=el('p','cm-head');
    head.appendChild(el('span','cm-name',c.name)); head.appendChild(el('span','cm-date',fmt(c.created_at)));
    li.appendChild(head); li.appendChild(el('p','cm-msg',c.message));
    if(c.reply){var r=el('div','cm-reply');r.appendChild(el('p','cm-name',teacher+' 回覆'));r.appendChild(el('p','cm-msg',c.reply));li.appendChild(r);}
    list.appendChild(li); shown++; num.textContent=shown?'（'+shown+'）':''; empty.hidden=shown>0;
  }
  fetch('/api/post?slug='+encodeURIComponent(slug)).then(function(r){return r.json();}).then(function(d){
    if(!d||!d.ok) return;
    if(d.teacher) teacher=d.teacher;
    tsKey=d.turnstileSiteKey||'';
    count=d.likes||0; if(liked&&count===0) count=1; showLike();
    (d.comments||[]).forEach(addItem);
  }).catch(function(){});

  var form=document.getElementById('cm-form'), msg=document.getElementById('cm-msg');
  function loadTs(){
    if(!tsKey||tsWidget!==null) return;
    function render(){if(tsWidget===null&&window.turnstile)tsWidget=window.turnstile.render('#cm-ts',{sitekey:tsKey,language:'zh-tw',size:'flexible'});}
    if(window.turnstile) return render();
    window.rouCmTs=render;
    if(!document.getElementById('cm-ts-js')){var s=document.createElement('script');s.id='cm-ts-js';s.async=true;s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=rouCmTs';document.head.appendChild(s);}
  }
  form.addEventListener('focusin',loadTs);
  form.addEventListener('submit',function(e){
    e.preventDefault(); loadTs();
    var btn=form.querySelector('button[type=submit]'); btn.disabled=true; msg.textContent='';
    var token=tsWidget!==null&&window.turnstile?window.turnstile.getResponse(tsWidget)||'':'';
    post('/api/comment',{post:slug,name:form.name.value,message:form.message.value,hp:form.hp.value,turnstile:token}).then(function(x){
      btn.disabled=false;
      if(tsWidget!==null&&window.turnstile) window.turnstile.reset(tsWidget);
      if(x.ok){ if(x.j.comment) addItem(x.j.comment); form.message.value=''; msg.textContent='已送出，謝謝你的留言！'; msg.className='cm-ok'; }
      else{ msg.className='fb-err'; msg.textContent=(x.j&&x.j.error)||'送出失敗，請稍後再試。'; }
    }).catch(function(){btn.disabled=false;msg.className='fb-err';msg.textContent='送出失敗，請稍後再試。';});
  });
})();
