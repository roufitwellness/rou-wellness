(function(){
  // 顯示已公開的回饋
  var box=document.querySelector('[data-feedback]');
  if(box){
    fetch('/api/feedback').then(function(r){return r.json()}).then(function(d){
      var items=(d&&d.items)||[]; if(!items.length) return;
      var list=box.querySelector('.fb-list');
      items.forEach(function(it){
        var fig=document.createElement('figure'); fig.className='fb-card';
        var bq=document.createElement('blockquote'); bq.textContent=it.message;
        var cap=document.createElement('figcaption'); cap.textContent='— '+(it.name||'學員');
        fig.appendChild(bq); fig.appendChild(cap); list.appendChild(fig);
      });
      box.hidden=false;
    }).catch(function(){});
  }
  // 留言表單
  var form=document.getElementById('fb-form'); if(!form) return;
  var msg=document.getElementById('fb-msg');
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var btn=form.querySelector('button'); btn.disabled=true; msg.textContent='';
    fetch('/api/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      name:form.name.value, message:form.message.value, hp:form.hp.value})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok&&j.ok,j:j}})})
    .then(function(x){
      if(x.ok){form.hidden=true;document.getElementById('fb-thanks').hidden=false;}
      else{msg.textContent=(x.j&&x.j.error&&x.j.error.indexOf('-')<0)?x.j.error:'送出失敗，請稍後再試。';btn.disabled=false;}
    }).catch(function(){msg.textContent='送出失敗，請稍後再試。';btn.disabled=false;});
  });
})();
