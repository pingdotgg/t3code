(()=>{const q=(s)=>[...document.querySelectorAll(s)];
const hdr=q(".drag-region").map(e=>{const r=e.getBoundingClientRect();return [e.className.slice(0,40),Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]});
const pop=document.querySelector("[data-slot=popover-popup]");const pr=pop?.getBoundingClientRect();
const fav=q("button").filter(b=>/favorite/i.test(b.getAttribute("aria-label")||b.innerText||"")).map(b=>{const r=b.getBoundingClientRect();return [(b.getAttribute("aria-label")||b.innerText).trim().slice(0,30),Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]});
return {hdr, pop: pr&&[Math.round(pr.x),Math.round(pr.y),Math.round(pr.width),Math.round(pr.height)], popAppRegion: pop&&getComputedStyle(pop).webkitAppRegion||pop&&getComputedStyle(pop).getPropertyValue("-webkit-app-region"), fav, inner:[innerWidth,innerHeight]}})()
