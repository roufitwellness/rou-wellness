(function(){
  function $(id){return document.getElementById(id)}
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function res(r){return r.json().then(function(j){return {ok:r.ok&&j.ok!==false,j:j,status:r.status}},function(){return {ok:false,j:{},status:r.status}})}
  function api(path,body){
    return fetch(path,body===undefined?{credentials:'same-origin'}:{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json','x-requested-with':'rou'},body:JSON.stringify(body)}).then(res);
  }
  var FAIL='連線失敗，請稍後再試。';
  var params=new URLSearchParams(location.search);

  // ---------- 用信裡的取消連結進來 ----------
  var t=params.get('cancel');
  if(t){
    ['bk-main','bk-done'].forEach(function(x){$(x).hidden=true});$('bk-cancel').hidden=false;
    var info=$('bk-cancel-info'),cmsg=$('bk-cancel-msg'),cbtn=$('bk-cancel-btn');
    fetch('/api/booking/cancel?t='+encodeURIComponent(t)).then(res).then(function(x){
      if(!x.ok){info.textContent=x.j.error||FAIL;return}
      var d=x.j; info.textContent=d.name+'，你預約的是：'+d.service+'　'+d.when;
      if(d.status!=='booked'){cmsg.textContent='這筆預約已經取消了。';return}
      if(!d.canCancel){cmsg.textContent='開課前 '+d.cancelBeforeHours+' 小時內無法線上取消，請直接傳訊息給老師。';return}
      cbtn.hidden=false;
    }).catch(function(){info.textContent=FAIL});
    cbtn.addEventListener('click',function(){
      if(!confirm('確定要取消這堂課嗎？'))return;
      cbtn.disabled=true;
      fetch('/api/booking/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t})})
      .then(res).then(function(x){
        if(x.ok){cbtn.hidden=true;cmsg.textContent='已經幫你取消了，謝謝你提早告知。'}
        else{cmsg.textContent=x.j.error||FAIL;cbtn.disabled=false}
      }).catch(function(){cmsg.textContent=FAIL;cbtn.disabled=false});
    });
    return;
  }

  var user=null,slots=[],filter='',chosen=null,tsWidget=null,tsKey='';
  var list=$('bk-slots'),form=$('bk-form'),fmsg=$('bk-msg');

  // ---------- 登入 ----------
  var LOGIN_MSG={fail:'登入沒有成功，請再試一次。',expired:'登入連結已經過期或用過了，請重新寄一次。',off:'這個登入方式還沒有開放。'};
  if(params.get('login')){
    $('bk-login-msg').textContent=LOGIN_MSG[params.get('login')]||LOGIN_MSG.fail;
    history.replaceState(null,'',location.pathname);
  }

  function loadTurnstile(){
    if(!tsKey||window.turnstile)return renderTs();
    window.rouTsReady=renderTs;
    var s=document.createElement('script');
    s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=rouTsReady';s.async=true;
    document.head.appendChild(s);
  }
  function renderTs(){
    if(!tsKey||!window.turnstile||tsWidget!==null)return;
    tsWidget=window.turnstile.render('#bk-ts',{sitekey:tsKey,language:'zh-tw',size:'flexible'});
  }
  function tsToken(){return tsWidget!==null&&window.turnstile?window.turnstile.getResponse(tsWidget)||'':''}
  function tsReset(){if(tsWidget!==null&&window.turnstile)window.turnstile.reset(tsWidget)}

  $('bk-email-form').addEventListener('submit',function(e){
    e.preventDefault();
    var f=this,btn=f.querySelector('button'),msg=$('bk-login-msg'),email=f.email.value.trim();
    msg.textContent='';
    if(!email){msg.textContent='請填寫 Email';return}
    if(tsKey&&!tsToken()){msg.textContent='請稍等驗證完成，再按一次。';return}
    btn.disabled=true;
    api('/api/login-link',{email:email,turnstile:tsToken()}).then(function(x){
      btn.disabled=false;tsReset();
      if(x.ok){f.hidden=true;$('bk-or').hidden=true;$('bk-google').hidden=true;$('bk-sent-to').textContent=email;$('bk-sent').hidden=false;return}
      msg.textContent=x.j.error||FAIL;
    }).catch(function(){btn.disabled=false;tsReset();msg.textContent=FAIL});
  });
  $('bk-sent-again').addEventListener('click',function(){
    $('bk-sent').hidden=true;$('bk-email-form').hidden=false;
    $('bk-or').hidden=$('bk-google').hidden=$('bk-google').dataset.off==='1';
  });

  $('bk-logout').addEventListener('click',function(){
    api('/api/logout',{}).then(function(){location.reload()},function(){location.reload()});
  });

  function showAccount(cfg){
    user=cfg.user;
    $('bk-login').hidden=!!user;
    $('bk-account').hidden=!user;
    if(user){
      $('bk-who').textContent=user.email;
      if(!form.name.value)form.name.value=user.name||'';
      if(!form.contact.value)form.contact.value=user.phone||'';
      loadMine();
    }else{
      var g=$('bk-google');g.hidden=!cfg.google;g.dataset.off=cfg.google?'0':'1';
      $('bk-email-form').hidden=!cfg.emailLogin;
      $('bk-or').hidden=!(cfg.google&&cfg.emailLogin);
      if(!cfg.google&&!cfg.emailLogin)$('bk-login-msg').textContent='線上預約還沒有開放，請直接傳訊息給老師。';
      tsKey=cfg.turnstileSiteKey||'';
      if(cfg.emailLogin)loadTurnstile();
    }
  }

  // ---------- 我的預約 ----------
  function loadMine(){
    api('/api/my/bookings').then(function(x){
      var box=$('bk-mine-list');box.textContent='';
      var items=(x.ok&&x.j.items)||[];
      $('bk-mine').hidden=!items.length;
      items.forEach(function(b){
        var li=el('li');
        var txt=el('div');txt.appendChild(el('b',null,b.when));txt.appendChild(el('span','s',b.service+(b.seats>1?'（'+b.seats+' 人）':'')+(b.room?'・'+b.room:'')));li.appendChild(txt);
        if(b.canCancel){
          var c=el('button','linkish','取消');c.type='button';
          c.addEventListener('click',function(){
            if(!confirm('確定要取消 '+b.when+' 的課嗎？'))return;
            c.disabled=true;
            api('/api/my/cancel',{id:b.id}).then(function(r){
              if(r.ok){loadMine();fetchSlots()}else{alert(r.j.error||FAIL);c.disabled=false}
            }).catch(function(){alert(FAIL);c.disabled=false});
          });
          li.appendChild(c);
        }else li.appendChild(el('span','s','要取消請傳訊息給老師'));
        box.appendChild(li);
      });
    }).catch(function(){});
  }

  // ---------- 時段 ----------
  function fetchSlots(){
    return fetch('/api/booking/slots').then(res).then(function(x){
      if(!x.ok){list.textContent='';list.appendChild(el('p','fb-err',x.j.error||FAIL));return}
      slots=x.j.items||[];
      $('bk-rule').textContent='開課前 '+x.j.bookBeforeHours+' 小時停止線上預約；開課前 '+x.j.cancelBeforeHours+' 小時以前可以自己取消。';
      render();
    }).catch(function(){list.textContent='';list.appendChild(el('p','fb-err',FAIL))});
  }

  function render(){
    var svcs=[];slots.forEach(function(s){if(svcs.indexOf(s.service)<0)svcs.push(s.service)});
    if(filter&&svcs.indexOf(filter)<0)filter='';
    var bar=$('bk-filter');bar.textContent='';bar.hidden=svcs.length<2;
    [''].concat(svcs).forEach(function(s){
      var b=el('button','fchip'+(filter===s?' on':''),s||'全部');b.type='button';
      b.setAttribute('aria-pressed',filter===s?'true':'false');
      b.addEventListener('click',function(){filter=s;render()});bar.appendChild(b);
    });
    list.textContent='';
    var items=slots.filter(function(s){return !filter||s.service===filter});
    if(!items.length){list.appendChild(el('p','lead','目前沒有可以預約的時段，老師開放新時段後會再通知。'));return}
    var day='',grid;
    items.forEach(function(s){
      if(s.date!==day){day=s.date;list.appendChild(el('h3','bk-day',s.when.split('）')[0]+'）'));grid=el('div','bk-grid');list.appendChild(grid)}
      var b=el('button','bk-slot'+(chosen&&chosen.id===s.id?' on':''));b.type='button';
      b.appendChild(el('span','t',s.when.split('）')[1]));
      b.appendChild(el('span','s',s.service));
      if(s.room)b.appendChild(el('span','r','📍'+s.room));
      var need=1+(s.friends||0),full=s.left<need;
      b.appendChild(el('span','n',full?'已額滿':s.friends?need+' 人課・需自己找'+(s.friends===1?'一位':s.friends+' 位')+'朋友':(s.left===1?'可預約':'剩 '+s.left+' 位')));
      if(full){b.disabled=true}
      else b.addEventListener('click',function(){chosen=s;render();openForm()});
      grid.appendChild(b);
    });
  }

  function openForm(){
    if(!user){
      $('bk-login-msg').textContent='請先登入，就能預約 '+chosen.when+' 的課。';
      $('bk-login').scrollIntoView({behavior:'smooth',block:'start'});
      return;
    }
    $('bk-chosen').textContent=chosen.service+'　'+chosen.when;
    setupPartners();
    form.hidden=false;fmsg.textContent='';
    form.scrollIntoView({behavior:'smooth',block:'start'});
    if(!form.name.value)setTimeout(function(){form.name.focus({preventScroll:true})},300);
  }

  // ---------- 一對二課程的同行朋友 ----------
  var prows=$('bk-partner-rows'),addP=$('bk-add-partner');
  function maxPartners(){return chosen?(chosen.friends||0):0}
  function partnerRow(first){
    var row=el('div','bk-prow');
    var n=el('input');n.name='pname';n.placeholder='朋友的姓名';n.maxLength=30;n.autocomplete='off';
    var t=el('input');t.name='pphone';t.placeholder='朋友的電話';t.maxLength=30;t.type='tel';t.autocomplete='off';
    var m=el('input');m.name='pemail';m.placeholder='朋友的 Email（選填，填了朋友也會收到確認信和提醒）';m.maxLength=100;m.type='email';m.autocomplete='off';m.inputMode='email';
    row.appendChild(n);row.appendChild(t);row.appendChild(m);
    if(!first){var x=el('button','linkish','移除');x.type='button';x.addEventListener('click',function(){row.remove();syncAdd()});row.appendChild(x)}
    prows.appendChild(row);syncAdd();return row;
  }
  function syncAdd(){addP.hidden=prows.children.length>=maxPartners()}
  addP.addEventListener('click',function(){partnerRow(false).querySelector('input').focus()});
  function setupPartners(){
    var g=!!(chosen&&chosen.group);
    $('bk-partners').hidden=!g;
    form.contact.required=g;
    $('bk-contact-hint').textContent=g?'（一對二課程必填，臨時有變動時方便聯絡你）':'（選填，臨時有變動時方便聯絡你）';
    if(g){
      while(prows.children.length>maxPartners())prows.lastChild.remove();
      while(prows.children.length<maxPartners())partnerRow(true);
      syncAdd();
    }
  }
  function collectPartners(){
    if(!(chosen&&chosen.group))return [];
    return [].map.call(prows.children,function(r){return {name:r.querySelector('[name=pname]').value,phone:r.querySelector('[name=pphone]').value,email:r.querySelector('[name=pemail]').value}});
  }

  form.addEventListener('submit',function(e){
    e.preventDefault();if(!chosen)return;
    if(!form.agree.checked){fmsg.textContent='請先閱讀預約須知與條款，並勾選同意。';form.agree.focus();return}
    var btn=form.querySelector('button[type=submit]');btn.disabled=true;fmsg.textContent='';
    api('/api/booking',{slot_id:chosen.id,name:form.name.value,contact:form.contact.value,note:form.note.value,partners:collectPartners(),agree:form.agree.checked,terms:form.querySelector('.bk-terms').dataset.version}).then(function(x){
      btn.disabled=false;
      if(x.ok){
        var d=x.j;
        $('bk-done-what').textContent=d.service+'　'+d.when;
        var place=$('bk-done-place');place.textContent='';
        if(d.room){
          place.appendChild(el('p',null,'地點：'+d.room+(d.roomAddress?'（'+d.roomAddress+'）':'')));
          if(d.roomUrl){var pa=el('p');pa.appendChild(document.createTextNode('地址與交通指引：'));var a=el('a',null,'打開指引');a.href=d.roomUrl;a.target='_blank';a.rel='noopener';pa.appendChild(a);place.appendChild(pa)}
        }
        if(d.partners&&d.partners.length)place.appendChild(el('p',null,'一起上課的朋友：'+d.partners.join('、')+'（共 '+(d.partners.length+1)+' 人）。'+(d.friendMail?'朋友也會收到確認信和上課提醒。':'朋友不會收到信，麻煩幫忙轉告喔！')));
        if(d.prep)place.appendChild(el('p',null,d.prep));
        if(d.deposit){var dp=el('p','bk-deposit');dp.appendChild(el('b',null,'訂金：'));dp.appendChild(document.createTextNode(d.deposit+' '));var la=el('a',null,'打開官方 LINE');la.href=d.lineUrl;la.target='_blank';la.rel='noopener';dp.appendChild(la);place.appendChild(dp)}
        $('bk-done-mail').textContent=d.mail?'確認信已寄到 '+d.email+'。沒收到的話請看一下垃圾郵件匣。':'';
        $('bk-main').hidden=true;$('bk-done').hidden=false;window.scrollTo(0,0);return;
      }
      if(x.status===401){location.reload();return}
      fmsg.textContent=x.j.error||FAIL;
      if(x.j.full){chosen=null;form.hidden=true;fetchSlots()}
    }).catch(function(){btn.disabled=false;fmsg.textContent=FAIL});
  });
  $('bk-again').addEventListener('click',function(){
    chosen=null;form.hidden=true;form.note.value='';prows.textContent='';form.agree.checked=false;
    $('bk-done').hidden=true;$('bk-main').hidden=false;loadMine();fetchSlots();window.scrollTo(0,0);
  });

  fetch('/api/me',{credentials:'same-origin'}).then(function(r){return r.json()}).then(showAccount)
    .catch(function(){$('bk-login-msg').textContent=FAIL});
  fetchSlots();
})();
