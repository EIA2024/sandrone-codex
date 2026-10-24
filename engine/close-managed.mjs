// No renderer scripts: request a graceful quit of one previously verified browser.
const i=process.argv.indexOf('--browser-id');
const browserId=i>=0?process.argv[i+1]:'';
if(!/^[A-Za-z0-9._-]{1,200}$/.test(browserId))throw new Error('Invalid browser identity');
const expected=`ws://127.0.0.1:19337/devtools/browser/${browserId}`;
const response=await fetch('http://127.0.0.1:19337/json/version',{signal:AbortSignal.timeout(3000),redirect:'error'});
if(!response.ok)throw new Error('Browser endpoint unavailable');
const version=await response.json();
if(version.webSocketDebuggerUrl!==expected)throw new Error('Browser identity changed; refused close');
await new Promise((resolve,reject)=>{
 const socket=new WebSocket(expected);
 const timer=setTimeout(()=>{socket.close();reject(new Error('Graceful close timed out; close the themed window manually'));},7000);
 let requested=false;
 socket.onopen=()=>{requested=true;socket.send(JSON.stringify({id:1,method:'Browser.close'}));};
 socket.onclose=()=>{clearTimeout(timer);requested?resolve():reject(new Error('Browser connection closed before the request'));};
 socket.onerror=()=>{clearTimeout(timer);reject(new Error('Browser close connection failed'));};
 socket.onmessage=e=>{try{const result=JSON.parse(e.data);if(result.id===1&&result.error){clearTimeout(timer);socket.close();reject(new Error('Browser refused graceful close'));}}catch{}};
});
console.log('Graceful close requested for the verified themed browser.');
