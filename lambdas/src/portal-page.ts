// The affiliate portal's HTML, served by the portal Lambda (DESIGN.md §5).
//
// This is the page the merchant's PARTNERS see, so it wears the merchant's name, logo and
// colour — never ours (D10, white label). One link is all a merchant has to share: someone
// arrives, signs up, verifies their email, and walks away with their own code, without the
// merchant building a protected page or approving anything by hand (unless they chose to).
//
// Dependency-free ON PURPOSE: the page ships inside a Lambda zip, must paint instantly on a
// phone, and — like everything else in this poppy — makes no request to any third party.
// It talks to Cognito for sign-up/sign-in and to /api/* for the affiliate's own numbers.
//
// It renders NO data before authentication: the markup below is a sign-up form and the
// merchant's public offer. Every number arrives afterwards, from an authenticated fetch.

import type { PortalBranding, ProgramSettings } from "../../shared/src/settings";

export interface PageConfig {
  region: string;
  userPoolClientId: string;
  branding: PortalBranding;
  settings: ProgramSettings;
  /** The offer sentence, already resolved (merchant's words, or the generated default). */
  offer: string;
  /** True once the merchant's Stripe is connected — otherwise signups can't get a code yet. */
  stripeReady: boolean;
}

/**
 * Escape a value for safe inclusion in a JS string literal inside <script>.
 *
 * JSON.stringify alone is NOT enough, and the gap is the classic one: it leaves `</script>`
 * intact, so a merchant whose terms text contains that sequence ends the script tag early and
 * everything after it is parsed as markup — their own affiliates would be served whatever
 * followed. Escaping `<` as < is equivalent inside a JS string and cannot close a tag.
 * (U+2028/9 are legal in JSON strings but not in JS source before ES2019 — escaped for the
 * same "the page must not break on someone's paste" reason.)
 */
const js = (s: unknown) =>
  JSON.stringify(s ?? "")
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/** Escape a value for safe inclusion in HTML text. */
function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The password rule Cognito actually enforces, in the words we tell the affiliate. */
export const PASSWORD_RULES = "At least 10 characters, with a lower-case letter and a number.";

export function portalHtml(cfg: PageConfig): string {
  const name = cfg.branding.merchantName || "Affiliate programme";
  const accent = cfg.branding.accentColor || "#9dbbe8";
  const logo = cfg.branding.logoDataUri
    ? `<img class="logo" src="${esc(cfg.branding.logoDataUri)}" alt="">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(name)} — affiliate programme</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#272e38;--fg:#e6edf3;--mut:#8b949e;--acc:${esc(accent)};--ok:#3fb950;--warn:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:24px 16px 64px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:13px;margin:0 0 12px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.mut{color:var(--mut);font-size:13px}
.logo{max-width:120px;max-height:48px;display:block;margin-bottom:12px}
label{display:block;margin-top:14px;font-size:13px;color:var(--mut)}
input{width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--line);background:#0b0f14;color:var(--fg);font-size:16px;margin-top:6px}
button{background:var(--acc);border:none;color:#0d1117;padding:11px 16px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
button[disabled]{opacity:.55;cursor:progress}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--fg);font-weight:400}
button.link{background:none;border:none;color:var(--acc);padding:0;font-size:13px;font-weight:400;cursor:pointer;text-decoration:underline}
.wide{width:100%;margin-top:18px}
.err{background:#2d1517;border:1px solid #6e2c31;color:#ffa198;border-radius:8px;padding:10px 12px;margin:12px 0;font-size:13px}
.ok{background:#12261a;border:1px solid #2b5c39;color:#7ee2a8;border-radius:8px;padding:10px 12px;margin:12px 0;font-size:13px}
.note{background:#20242c;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:12px 0;font-size:13px;color:var(--mut)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.spread{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.code{font:600 26px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;background:#0b0f14;border:1px dashed var(--acc);border-radius:10px;padding:16px;text-align:center;word-break:break-all}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.kpi{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}
.kl{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--mut);font-weight:500;padding:6px 0;border-bottom:1px solid var(--line)}
td{padding:8px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
td:last-child,th:last-child{text-align:right}
.terms{white-space:pre-wrap;font-size:13px;color:var(--mut);max-height:260px;overflow:auto}
.hide{display:none}
.badge{display:inline-block;font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.badge.on{color:var(--ok);border-color:#2b5c39}
.badge.wait{color:var(--warn);border-color:#5c4a1a}
.pl{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
.pl:last-child{border-bottom:0}
.pl a{color:var(--fg);text-decoration:none;overflow-wrap:anywhere}
.pl a:hover{text-decoration:underline}
.pl .host{color:var(--mut);font-size:12px}
</style>
</head>
<body>
<div class="wrap">

  <div id="public" class="hide">
    <div class="card">
      ${logo}
      <h1>${esc(name)}</h1>
      <p id="offer" style="margin:0 0 4px"></p>
      <p class="mut" style="margin:0">Share your code. When someone uses it, they save${
        cfg.settings.discountPct ? ` ${cfg.settings.discountPct}%` : ""
      } and you earn — no links to track, no cookies, nothing to install.</p>
    </div>

    <div class="card" id="joinCard">
      <h2>Join the programme</h2>
      <div id="joinMsg"></div>
      <form id="joinForm">
        <label>Your name or channel<input id="jName" autocomplete="name" required maxlength="40"></label>
        <label>Email<input id="jEmail" type="email" autocomplete="email" required></label>
        <label>Choose a password<input id="jPassword" type="password" autocomplete="new-password" required></label>
        <div class="mut" style="margin-top:6px">${esc(PASSWORD_RULES)}</div>
        <button class="wide" id="joinBtn" type="submit">Create my account</button>
      </form>
      <p class="mut" style="margin:14px 0 0">Already joined? <button class="link" id="toSignin">Sign in</button></p>
    </div>

    <div class="card hide" id="verifyCard">
      <h2>Check your email</h2>
      <p class="mut" style="margin:0">We sent a 6-digit code to <span id="verifyWho"></span>. Enter it to finish.</p>
      <div id="verifyMsg"></div>
      <form id="verifyForm">
        <label>Code<input id="vCode" inputmode="numeric" autocomplete="one-time-code" required></label>
        <button class="wide" id="verifyBtn" type="submit">Confirm</button>
      </form>
      <p class="mut" style="margin:14px 0 0"><button class="link" id="resend">Send it again</button></p>
    </div>

    <div class="card hide" id="signinCard">
      <h2>Sign in</h2>
      <div id="signinMsg"></div>
      <form id="signinForm">
        <label>Email<input id="sEmail" type="email" autocomplete="username" required></label>
        <label>Password<input id="sPassword" type="password" autocomplete="current-password" required></label>
        <button class="wide" id="signinBtn" type="submit">Sign in</button>
      </form>
      <p class="mut" style="margin:14px 0 0">
        <button class="link" id="toJoin">Create an account</button> ·
        <button class="link" id="toReset">Forgot password</button>
      </p>
    </div>

    <div class="card hide" id="resetCard">
      <h2>Reset your password</h2>
      <div id="resetMsg"></div>
      <form id="resetForm">
        <label>Email<input id="rEmail" type="email" autocomplete="username" required></label>
        <div id="resetStep2" class="hide">
          <label>Code from your email<input id="rCode" inputmode="numeric" autocomplete="one-time-code"></label>
          <label>New password<input id="rPassword" type="password" autocomplete="new-password"></label>
          <div class="mut" style="margin-top:6px">${esc(PASSWORD_RULES)}</div>
        </div>
        <button class="wide" id="resetBtn" type="submit">Send me a code</button>
      </form>
      <p class="mut" style="margin:14px 0 0"><button class="link" id="resetBack">Back to sign in</button></p>
    </div>
  </div>

  <div id="app" class="hide">
    <div class="card">
      <div class="spread">
        <div>${logo}<h1 style="margin:0">${esc(name)}</h1></div>
        <button class="ghost" id="signout">Sign out</button>
      </div>
    </div>
    <div id="appErr"></div>
    <div class="card">
      <div class="spread" style="margin-bottom:12px">
        <h2 style="margin:0">Your code</h2>
        <span id="status" class="badge"></span>
      </div>
      <div id="codeBox"></div>
    </div>
    <div class="card" id="earningsCard">
      <h2>Your earnings</h2>
      <div id="totals"></div>
    </div>
    <div class="card" id="historyCard">
      <h2>History</h2>
      <div id="history"></div>
    </div>
    <div class="card" id="placesCard">
      <h2>Where you share your code</h2>
      <p class="mut" style="margin:0 0 4px"><strong>Optional — you don't need to fill this in.</strong>
        It's just nice for ${esc(cfg.branding.merchantName || "the programme owner")} to know where their code is out there,
        so they can go and see your video, post or page.</p>
      <div id="placesMsg"></div>
      <div id="placesList"></div>
      <form id="placesForm" class="row" style="margin-top:10px;align-items:flex-end">
        <label style="flex:2;min-width:180px;margin:0">Link<input id="plUrl" type="url" placeholder="https://" inputmode="url"></label>
        <label style="flex:1;min-width:120px;margin:0">What it is (optional)<input id="plNote" placeholder="e.g. YouTube review" maxlength="80"></label>
        <button id="plAdd" type="submit">Add</button>
      </form>
    </div>
    <div class="card" id="termsCard">
      <h2>Programme terms</h2>
      <div class="terms" id="terms"></div>
    </div>
  </div>

</div>
<script>
(function(){
"use strict";
var REGION=${js(cfg.region)},CLIENT=${js(cfg.userPoolClientId)};
var OFFER=${js(cfg.offer)},TERMS=${js(cfg.branding.termsText)},RULES=${js(PASSWORD_RULES)};
var STRIPE_READY=${cfg.stripeReady ? "true" : "false"};
var COG="https://cognito-idp."+REGION+".amazonaws.com/";
var tok=null,pendingEmail="",pendingPassword="";
var $=function(id){return document.getElementById(id)};
function show(el,on){if(el)el.classList[on?"remove":"add"]("hide")}
function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML}
function msg(id,text,kind){$(id).innerHTML=text?'<div class="'+(kind||"err")+'">'+esc(text)+"</div>":""}
function money(cents,cur){
  var v=(cents||0)/100;
  try{return new Intl.NumberFormat(undefined,{style:"currency",currency:(cur||"usd").toUpperCase()}).format(v)}
  catch(e){return v.toFixed(2)+" "+String(cur||"").toUpperCase()}
}
function busy(btn,on,label){
  if(!btn)return;
  if(on){btn.dataset.label=btn.textContent;btn.disabled=true;btn.textContent=label||"Working…"}
  else{btn.disabled=false;if(btn.dataset.label)btn.textContent=btn.dataset.label}
}

// ── Cognito, spoken directly ─────────────────────────────────────────────────────────
// A public app client needs no signature, so the browser can call Cognito itself: no SDK
// to download on a phone, and no request of ours in the middle of someone's password.
function cognito(target,body){
  return fetch(COG,{method:"POST",headers:{"content-type":"application/x-amz-json-1.1","x-amz-target":"AWSCognitoIdentityProviderService."+target},body:JSON.stringify(body)})
    .then(function(r){return r.json().then(function(j){
      if(!r.ok){
        var t=j.__type||"";
        // Cognito's raw policy error never states the actual rule — say the one that does.
        if(t.indexOf("InvalidPasswordException")>=0)throw new Error("That password doesn't meet the requirements. "+RULES);
        if(t.indexOf("UsernameExistsException")>=0)throw new Error("There's already an account with that email — sign in instead.");
        if(t.indexOf("CodeMismatchException")>=0)throw new Error("That code doesn't match. Check the email and try again.");
        if(t.indexOf("ExpiredCodeException")>=0)throw new Error("That code has expired — ask for a new one.");
        if(t.indexOf("NotAuthorizedException")>=0)throw new Error("That email and password don't match an account.");
        if(t.indexOf("UserNotConfirmedException")>=0)throw new Error("Your email isn't confirmed yet — check your inbox for the code.");
        if(t.indexOf("LimitExceededException")>=0)throw new Error("Too many attempts. Please wait a minute and try again.");
        throw new Error(j.message||"That didn't work.");
      }
      return j;
    })});
}

function saveTokens(res){
  tok=res.IdToken;
  try{sessionStorage.setItem("ap_tok",tok)}catch(e){}
  if(res.RefreshToken){try{localStorage.setItem("ap_rt",res.RefreshToken)}catch(e){}}
}
function refreshSession(){
  var rt=null;try{rt=localStorage.getItem("ap_rt")}catch(e){}
  if(!rt)return Promise.resolve(false);
  return cognito("InitiateAuth",{AuthFlow:"REFRESH_TOKEN_AUTH",ClientId:CLIENT,AuthParameters:{REFRESH_TOKEN:rt}})
    .then(function(res){if(!res.AuthenticationResult)return false;saveTokens(res.AuthenticationResult);return true})
    .catch(function(){return false});
}
function signout(){
  tok=null;
  try{sessionStorage.removeItem("ap_tok")}catch(e){}
  try{localStorage.removeItem("ap_rt")}catch(e){}
  show($("app"),false);show($("public"),true);screen("joinCard");
}

// ── our own API ──────────────────────────────────────────────────────────────────────
function api(path,method,body,retried){
  return fetch(path,{
    method:method||"GET",
    headers:{authorization:"Bearer "+tok,"content-type":"application/json"},
    body:body?JSON.stringify(body):undefined
  }).then(function(r){
    if(r.status===401&&!retried){
      return refreshSession().then(function(ok){
        if(ok)return api(path,method,body,true);
        signout();throw new Error("Your session ended — please sign in again.");
      });
    }
    return r.json().catch(function(){return {}}).then(function(j){
      if(!r.ok)throw new Error(j.error||"Something went wrong.");
      return j;
    });
  });
}

// ── the public screens ───────────────────────────────────────────────────────────────
var SCREENS=["joinCard","verifyCard","signinCard","resetCard"];
function screen(which){
  for(var i=0;i<SCREENS.length;i++)show($(SCREENS[i]),SCREENS[i]===which);
}
$("toSignin").addEventListener("click",function(){screen("signinCard")});
$("toJoin").addEventListener("click",function(){screen("joinCard")});
$("toReset").addEventListener("click",function(){screen("resetCard")});
$("resetBack").addEventListener("click",function(){screen("signinCard")});

$("joinForm").addEventListener("submit",function(ev){
  ev.preventDefault();msg("joinMsg","");
  var btn=$("joinBtn");busy(btn,true,"Creating…");
  pendingEmail=$("jEmail").value.trim();pendingPassword=$("jPassword").value;
  var name=$("jName").value.trim();
  cognito("SignUp",{ClientId:CLIENT,Username:pendingEmail,Password:pendingPassword,
    UserAttributes:[{Name:"email",Value:pendingEmail},{Name:"name",Value:name}]})
    .then(function(){
      $("verifyWho").textContent=pendingEmail;
      screen("verifyCard");msg("verifyMsg","");
    })
    .catch(function(e){msg("joinMsg",e.message)})
    .then(function(){busy(btn,false)});
});

$("verifyForm").addEventListener("submit",function(ev){
  ev.preventDefault();msg("verifyMsg","");
  var btn=$("verifyBtn");busy(btn,true,"Confirming…");
  cognito("ConfirmSignUp",{ClientId:CLIENT,Username:pendingEmail,ConfirmationCode:$("vCode").value.trim()})
    .then(function(){
      return cognito("InitiateAuth",{AuthFlow:"USER_PASSWORD_AUTH",ClientId:CLIENT,
        AuthParameters:{USERNAME:pendingEmail,PASSWORD:pendingPassword}});
    })
    .then(function(res){
      if(!res.AuthenticationResult)throw new Error("Signed up, but signing in failed — try signing in.");
      saveTokens(res.AuthenticationResult);
      pendingPassword="";
      return enrollAndOpen();
    })
    .catch(function(e){msg("verifyMsg",e.message)})
    .then(function(){busy(btn,false)});
});

$("resend").addEventListener("click",function(){
  msg("verifyMsg","");
  cognito("ResendConfirmationCode",{ClientId:CLIENT,Username:pendingEmail})
    .then(function(){msg("verifyMsg","Sent. It can take a minute to arrive.","ok")})
    .catch(function(e){msg("verifyMsg",e.message)});
});

$("signinForm").addEventListener("submit",function(ev){
  ev.preventDefault();msg("signinMsg","");
  var btn=$("signinBtn");busy(btn,true,"Signing in…");
  var email=$("sEmail").value.trim();
  cognito("InitiateAuth",{AuthFlow:"USER_PASSWORD_AUTH",ClientId:CLIENT,
    AuthParameters:{USERNAME:email,PASSWORD:$("sPassword").value}})
    .then(function(res){
      if(!res.AuthenticationResult)throw new Error("Sign-in failed.");
      saveTokens(res.AuthenticationResult);
      return enrollAndOpen();
    })
    .catch(function(e){
      // An unconfirmed account is a half-finished signup, not a wrong password: put them
      // back on the code screen rather than into a loop they cannot leave.
      if(/isn't confirmed/.test(e.message)){pendingEmail=email;$("verifyWho").textContent=email;screen("verifyCard")}
      msg("signinMsg",e.message);
    })
    .then(function(){busy(btn,false)});
});

$("resetForm").addEventListener("submit",function(ev){
  ev.preventDefault();msg("resetMsg","");
  var btn=$("resetBtn"),email=$("rEmail").value.trim();
  var step2=!$("resetStep2").classList.contains("hide");
  busy(btn,true,"Working…");
  var p=step2
    ? cognito("ConfirmForgotPassword",{ClientId:CLIENT,Username:email,ConfirmationCode:$("rCode").value.trim(),Password:$("rPassword").value})
        .then(function(){msg("resetMsg","Password changed — sign in with it now.","ok");screen("signinCard")})
    : cognito("ForgotPassword",{ClientId:CLIENT,Username:email})
        .then(function(){show($("resetStep2"),true);$("resetBtn").dataset.label="Set new password";msg("resetMsg","Check your email for the code.","ok")});
  p.catch(function(e){msg("resetMsg",e.message)}).then(function(){busy(btn,false)});
});

$("signout").addEventListener("click",signout);

// ── the affiliate's own view ─────────────────────────────────────────────────────────
// Enrolment is idempotent on the server, so calling it on every sign-in is what makes a
// half-finished signup (verified but never enrolled) heal itself instead of dead-ending.
function enrollAndOpen(){
  return api("/api/enroll","POST",{}).then(open).catch(function(e){
    msg("appErr",e.message);show($("public"),false);show($("app"),true);
  });
}

function open(){
  show($("public"),false);show($("app"),true);
  return api("/api/me").then(render).catch(function(e){msg("appErr",e.message)});
}

function render(data){
  var a=data.affiliate||{},totals=data.totals||[],entries=data.entries||[];
  var badge=$("status");
  if(a.status==="active"){badge.className="badge on";badge.textContent="Active"}
  else if(a.status==="retired"){badge.className="badge";badge.textContent="Retired"}
  else{badge.className="badge wait";badge.textContent="Waiting for approval"}

  if(a.code){
    $("codeBox").innerHTML='<div class="code" id="theCode">'+esc(a.code)+"</div>"+
      '<div class="row" style="margin-top:12px"><button id="copy">Copy code</button>'+
      '<span class="mut" id="copied"></span></div>';
    $("copy").addEventListener("click",function(){
      var text=a.code;
      function done(ok){$("copied").textContent=ok?"Copied":"Select the code above to copy it."}
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){done(true)},function(){done(false)});
      }else{done(false)}
    });
  }else if(a.status==="pending"){
    $("codeBox").innerHTML='<p class="mut" style="margin:0">Your application is with '+esc(${js(cfg.branding.merchantName || "the programme owner")})+
      '. You\\'ll get your code here as soon as it\\'s approved — no need to check your email.</p>';
  }else{
    $("codeBox").innerHTML='<p class="mut" style="margin:0">'+
      (STRIPE_READY?"Your code is being prepared. Refresh in a moment.":"The programme isn't quite open yet. Your place is saved — check back soon.")+"</p>";
  }

  if(!totals.length){
    $("totals").innerHTML='<p class="mut" style="margin:0">Nothing yet. As soon as someone buys with your code, it shows up here.</p>';
  }else{
    var html="";
    for(var i=0;i<totals.length;i++){
      var t=totals[i];
      html+='<div style="margin-bottom:14px"><div class="grid">'+
        '<div><div class="kl">Earned</div><div class="kpi">'+esc(money(t.earnedCents,t.currency))+"</div></div>"+
        '<div><div class="kl">Refunded</div><div class="kpi">'+esc(money(-t.refundedCents,t.currency))+"</div></div>"+
        '<div><div class="kl">Paid to you</div><div class="kpi">'+esc(money(t.paidCents,t.currency))+"</div></div>"+
        '<div><div class="kl">Owed</div><div class="kpi">'+esc(money(t.owedCents,t.currency))+"</div></div>"+
        "</div></div>";
    }
    $("totals").innerHTML=html;
  }

  if(!entries.length){
    $("history").innerHTML='<p class="mut" style="margin:0">No entries yet.</p>';
  }else{
    var rows="";
    for(var k=0;k<entries.length;k++){
      var e=entries[k];
      var what=e.kind==="sale"?"Sale":e.kind==="renewal"?"Renewal":"Refund";
      rows+="<tr><td>"+esc(e.day)+"</td><td>"+esc(what)+"</td><td>"+esc(money(e.amountCents,e.currency))+"</td></tr>";
    }
    $("history").innerHTML='<table><thead><tr><th>Date</th><th>What</th><th>Commission</th></tr></thead><tbody>'+rows+"</tbody></table>";
  }

  renderPlaces(a.placements||[]);

  if(TERMS){$("terms").textContent=TERMS}
  else{show($("termsCard"),false)}
}

// ── where you share your code ────────────────────────────────────────────────────────
// Optional, and the page says so above the form. The whole list is sent on every change:
// it is small (capped server-side), and "the list you see is the list that's stored" is a
// simpler promise than reconciling adds and removes.
var places=[];
function host(u){try{return new URL(u).hostname.replace(/^www\./,"")}catch(e){return ""}}
function renderPlaces(list){
  places=list.slice();
  if(!places.length){$("placesList").innerHTML="";return}
  var html="";
  for(var i=0;i<places.length;i++){
    var p=places[i];
    html+='<div class="pl"><div><a href="'+esc(p.url)+'" target="_blank" rel="noopener noreferrer">'+esc(p.note||p.url)+"</a>"+
      (p.note?' <span class="host">'+esc(host(p.url))+"</span>":"")+"</div>"+
      '<button class="link" data-rm="'+i+'">Remove</button></div>';
  }
  $("placesList").innerHTML=html;
}
function savePlaces(next,btn){
  msg("placesMsg","");
  if(btn)busy(btn,true,"Saving…");
  return api("/api/placements","PUT",{placements:next}).then(function(d){
    renderPlaces(d.placements||[]);
  }).catch(function(e){msg("placesMsg",e.message)}).then(function(){if(btn)busy(btn,false)});
}
$("placesForm").addEventListener("submit",function(ev){
  ev.preventDefault();
  var url=$("plUrl").value.trim(),note=$("plNote").value.trim();
  if(!url)return;
  if(!/^https?:\/\//i.test(url))url="https://"+url;
  var next=places.concat([{url:url,note:note}]);
  savePlaces(next,$("plAdd")).then(function(){$("plUrl").value="";$("plNote").value=""});
});
$("placesList").addEventListener("click",function(ev){
  var t=ev.target;
  if(!(t&&t.dataset&&t.dataset.rm!==undefined))return;
  var idx=parseInt(t.dataset.rm,10);
  savePlaces(places.filter(function(_,i){return i!==idx}),t);
});

// ── boot ─────────────────────────────────────────────────────────────────────────────
$("offer").textContent=OFFER;
if(!STRIPE_READY){
  var n=document.createElement("div");
  n.className="note";
  n.textContent="This programme is still being set up. You can sign up now — your code arrives as soon as it opens.";
  $("joinCard").insertBefore(n,$("joinForm"));
}
show($("public"),true);screen("joinCard");
refreshSession().then(function(ok){if(ok)return open()});
})();
</script>
</body>
</html>`;
}
