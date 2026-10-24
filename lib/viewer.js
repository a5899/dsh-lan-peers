/**
 * Standalone conversation viewer for the LAN peers plugin.
 *
 * Served from the peer port, so it opens in any browser on the LAN — including
 * a phone — without DSH's authenticated /api pipeline. It is read-mostly: the
 * page lists conversations and shows the transcript, with the option to send a
 * line from the browser when the user is the one driving.
 *
 * Every screen is laid out mobile-first: one column, 44px touch targets, a
 * sticky header, and no horizontal scrolling at 320px.
 */
export const VIEWER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#11161d">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232f6fed'/%3E%3Ctext x='32' y='42' font-size='30' text-anchor='middle' fill='white' font-family='sans-serif'%3ED%3C/text%3E%3C/svg%3E">
<title>DSH 对话 · LAN 邻居</title>
<style>
:root{
  --bg:#f6f7f9; --panel:#fff; --fg:#16181d; --muted:#6b7280; --line:#e5e7eb;
  --accent:#2f6fed; --in:#eef2ff; --out:#e8f7ee; --err:#fdecec; --errfg:#b3261e;
  --radius:14px; --gap:12px;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#11161d; --panel:#181f29; --fg:#e8eaed; --muted:#9aa4b2; --line:#26303d;
    --accent:#7aa2ff; --in:#1b2740; --out:#16302a; --err:#3a1e1e; --errfg:#ff8a80;
  }
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg)}
body{
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  min-height:100vh; -webkit-text-size-adjust:100%;
}
header{
  position:sticky;top:0;z-index:10;background:var(--panel);border-bottom:1px solid var(--line);
  padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
}
header h1{font-size:16px;margin:0;font-weight:650;letter-spacing:.2px;flex:1;min-width:140px}
header .who{font-size:12px;color:var(--muted);width:100%}
.btn{
  appearance:none;border:1px solid var(--line);background:var(--panel);color:var(--fg);
  border-radius:10px;padding:0 14px;min-height:44px;font-size:14px;font-weight:550;cursor:pointer;
  display:inline-flex;align-items:center;gap:6px;white-space:nowrap;
}
.btn:active{transform:scale(.98)}
.btn.primary{background:var(--accent);border-color:transparent;color:#fff}
.btn.ghost{background:transparent}
.btn[disabled]{opacity:.45;cursor:default}
main{padding:var(--gap);max-width:860px;margin:0 auto}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.card + .card{margin-top:var(--gap)}
.card h2{font-size:13px;margin:0;padding:12px 14px;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line)}
.conv{
  display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);
  padding:14px;color:inherit;font:inherit;cursor:pointer;min-height:64px;
}
.conv:last-child{border-bottom:0}
.conv:active{background:var(--bg)}
.conv .top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.conv .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conv .time{font-size:12px;color:var(--muted);flex:none}
.conv .peek{font-size:13px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msg{
  padding:10px 14px;display:flex;flex-direction:column;gap:4px;
  border-bottom:1px solid var(--line);
}
.msg:last-child{border-bottom:0}
.msg .meta{font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.msg .tag{border-radius:999px;padding:0 7px;line-height:17px;border:1px solid currentColor;font-size:11px}
.msg .text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.msg.in{background:var(--in)}
.msg.out{background:var(--out)}
.msg.error{background:var(--err);color:var(--errfg)}
.empty{padding:28px 16px;text-align:center;color:var(--muted);font-size:14px}
.composer{padding:12px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:10px}
textarea{
  width:100%;min-height:76px;resize:vertical;border:1px solid var(--line);border-radius:10px;
  background:var(--bg);color:var(--fg);padding:10px 12px;font:inherit;
}
textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
select.pick{width:100%;min-height:44px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);padding:0 12px;font:inherit}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.status{font-size:12px;color:var(--muted);flex:1;min-width:120px}
.err{color:var(--errfg)}
a.link{color:var(--accent);text-decoration:none}
@media (min-width:720px){
  header h1{font-size:17px}
  main{padding:20px}
}
</style>
</head>
<body>
<header>
  <h1>DSH 对话记录</h1>
  <button class="btn ghost" id="refresh" type="button">刷新</button>
  <div class="who" id="who">正在读取…</div>
</header>
<main>
  <section class="card" id="listCard">
    <h2>会话</h2>
    <div id="list"><div class="empty">加载中…</div></div>
  </section>

  <section class="card" id="composeCard">
    <h2>发起对话</h2>
    <div class="composer" id="compose"></div>
  </section>

  <section class="card" id="threadCard" hidden>
    <h2 id="threadTitle">对话</h2>
    <div id="thread"></div>
    <div class="composer">
      <textarea id="input" placeholder="说点什么…（回车换行，点发送）"></textarea>
      <div class="row">
        <button class="btn primary" id="send" type="button">发送</button>
        <button class="btn ghost" id="back" type="button">返回列表</button>
        <span class="status" id="status"></span>
      </div>
    </div>
  </section>
</main>
<script>
(function(){
  "use strict";
  var API = "/peer/webapi/";
  var state = { conversations: [], conversation: null, peerName: "", peers: [], enabled: false, pickedPeer: null };

  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtTime(iso){
    try {
      var d = new Date(iso);
      var now = new Date();
      var sameDay = d.toDateString() === now.toDateString();
      var hh = String(d.getHours()).padStart(2,"0");
      var mm = String(d.getMinutes()).padStart(2,"0");
      return sameDay ? (hh+":"+mm) : (d.getMonth()+1)+"/"+d.getDate()+" "+hh+":"+mm;
    } catch (e) { return iso || ""; }
  }
  function get(path){
    return fetch(API + path, { credentials: "omit" }).then(function(r){
      return r.json().catch(function(){ return { ok:false, reason:"bad-json" }; });
    });
  }
  function post(path, body){
    return fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body || {})
    }).then(function(r){
      return r.json().catch(function(){ return { ok:false, reason:"bad-json" }; });
    });
  }

  function renderWho(s){
    var who = document.getElementById("who");
    if (!s || !s.ok) { who.textContent = "无法读取本机状态"; renderCompose(); return; }
    state.peers = s.peers || [];
    state.enabled = Boolean(s.enabled);
    renderCompose();
    who.textContent = "本机：" + s.name + " · " + (s.localAddress || "无地址") + " · " + (s.enabled ? "已启用" : "未启用")
      + (s.peers && s.peers.length ? " · 在线设备 " + s.peers.length : "");
  }

  function renderList(){
    var box = document.getElementById("list");
    box.textContent = "";
    if (!state.conversations.length){
      box.appendChild(el("div","empty","还没有任何往来记录。"));
      return;
    }
    state.conversations.forEach(function(c){
      var b = el("button","conv");
      b.type = "button";
      var top = el("div","top");
      top.appendChild(el("span","name", c.peerName || "未命名 DSH"));
      top.appendChild(el("span","time", fmtTime(c.lastAt)));
      b.appendChild(top);
      if (c.lastText) b.appendChild(el("div","peek", c.lastText));
      b.addEventListener("click", function(){ openConversation(c.id, c.peerName); });
      box.appendChild(b);
    });
  }

  function renderCompose(){
    var box = document.getElementById("compose");
    box.textContent = "";
    var peers = (state.peers || []).filter(function(p){ return !p.blocked; });
    if (!state.enabled) {
      box.appendChild(el("div","empty","内网互询未启用。请在 DSH 设置里打开后再来。"));
      return;
    }
    if (!peers.length) {
      box.appendChild(el("div","empty","还没有发现其他 DSH。先让对方装好本插件并启用，再点右上角刷新。"));
      return;
    }
    if (peers.length === 1) {
      state.pickedPeer = peers[0];
    }
    var who = el("select", "pick");
    who.id = "pickPeer";
    peers.forEach(function(p){
      var opt = el("option","", p.name + "  「" + (p.address || "?") + "」");
      opt.value = p.id;
      if (state.pickedPeer && state.pickedPeer.id === p.id) opt.selected = true;
      who.appendChild(opt);
    });
    who.addEventListener("change", function(){
      state.pickedPeer = peers.filter(function(p){ return p.id === who.value; })[0] || null;
    });
    if (!state.pickedPeer) state.pickedPeer = peers[0];

    var ta = el("textarea");
    ta.id = "newInput";
    ta.placeholder = "开个新对话，说点什么…";
    var btn = el("button","btn primary","发送");
    btn.type = "button";
    var status = el("span","status");
    status.id = "newStatus";
    btn.addEventListener("click", function(){
      var text = ta.value.trim();
      if (!text || !state.pickedPeer) return;
      btn.disabled = true;
      status.className = "status";
      status.textContent = "发送中…";
      post("send", { peer: state.pickedPeer.id, message: text })
        .then(function(data){
          btn.disabled = false;
          if (data && data.ok){
            ta.value = "";
            status.textContent = "已发送";
            loadList();
            openConversation(data.conversation, state.pickedPeer.name);
          } else {
            status.className = "status err";
            status.textContent = "发送失败：" + ((data && (data.reason||data.message)) || "未知");
          }
        })
        .catch(function(e){
          btn.disabled = false;
          status.className = "status err";
          status.textContent = "发送失败：" + (e && e.message || e);
        });
    });

    var row = el("div","row");
    row.appendChild(btn);
    row.appendChild(status);
    box.appendChild(who);
    box.appendChild(ta);
    box.appendChild(row);
  }

  function openConversation(id, peerName){
    state.conversation = id;
    state.peerName = peerName || "";
    document.getElementById("listCard").hidden = true;
    document.getElementById("composeCard").hidden = true;
    var card = document.getElementById("threadCard");
    card.hidden = false;
    document.getElementById("threadTitle").textContent = "对话 · " + (peerName || id);
    document.getElementById("status").textContent = "";
    loadThread();
  }

  function closeConversation(){
    state.conversation = null;
    document.getElementById("threadCard").hidden = true;
    document.getElementById("listCard").hidden = false;
    document.getElementById("composeCard").hidden = false;
    loadList();
  }

  function loadThread(){
    if (!state.conversation) return;
    get("messages?conversation=" + encodeURIComponent(state.conversation) + "&limit=300").then(function(data){
      var box = document.getElementById("thread");
      box.textContent = "";
      if (!data || !data.ok){
        box.appendChild(el("div","empty","读取失败：" + ((data && (data.reason||data.message)) || "未知")));
        return;
      }
      if (!data.messages.length){
        box.appendChild(el("div","empty","这个会话还没有消息。"));
        return;
      }
      data.messages.forEach(function(m){
        var cls = m.direction === "out" ? "out" : "in";
        if (m.kind === "error") cls += " error";
        var item = el("div","msg " + cls);
        var meta = el("div","meta");
        var label = m.direction === "out" ? "我" : (m.peerName || "对方");
        var kindMap = { ask:"问", answer:"答", tell:"告知", error:"错误" };
        meta.appendChild(el("span","", label));
        meta.appendChild(el("span","tag", kindMap[m.kind] || m.kind));
        meta.appendChild(el("span","", fmtTime(m.at)));
        item.appendChild(meta);
        item.appendChild(el("div","text", m.text));
        box.appendChild(item);
      });
      box.scrollTop = box.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
  }

  function loadList(){
    get("conversations").then(function(data){
      if (data && data.ok){ state.conversations = data.conversations || []; }
      else { state.conversations = []; }
      renderList();
    });
  }

  function loadStatus(){
    get("status").then(renderWho).catch(function(){ renderWho(null); });
  }

  document.getElementById("refresh").addEventListener("click", function(){
    loadStatus();
    if (state.conversation) loadThread(); else loadList();
  });
  document.getElementById("back").addEventListener("click", closeConversation);

  document.getElementById("send").addEventListener("click", function(){
    var btn = this;
    var input = document.getElementById("input");
    var status = document.getElementById("status");
    var text = input.value.trim();
    if (!text || !state.conversation) return;
    btn.disabled = true;
    status.className = "status";
    status.textContent = "发送中…";
    post("send", { peer: state.peerName || state.conversation, message: text, conversation: state.conversation })
      .then(function(data){
        btn.disabled = false;
        if (data && data.ok){
          input.value = "";
          status.textContent = "已发送";
          loadThread();
          setTimeout(function(){ if (status.textContent === "已发送") status.textContent = ""; }, 2000);
        } else {
          status.className = "status err";
          status.textContent = "发送失败：" + ((data && (data.reason||data.message)) || "未知");
        }
      })
      .catch(function(e){
        btn.disabled = false;
        status.className = "status err";
        status.textContent = "发送失败：" + (e && e.message || e);
      });
  });

  loadStatus();
  loadList();
  setInterval(function(){
    if (state.conversation) loadThread();
    else loadList();
  }, 5000);
})();
</script>
</body>
</html>`;
