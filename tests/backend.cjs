const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
let locked=false,records,actor,events;
const ctx={console,Date,JSON,Number,Math,String,LockService:{getScriptLock:()=>({waitLock(){assert(!locked);locked=true},releaseLock(){locked=false}})},Utilities:{parseDate:s=>new Date(s+'Z'),getUuid:()=> 'salt'},PropertiesService:{getScriptProperties:()=>({getProperty:()=>''})}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),ctx);
ctx.authUser_=()=>actor;ctx.rows_=tab=>records[tab]||[];ctx.setCells_=(tab,row,updates)=>{assert(locked);Object.assign(records[tab].find(x=>x._row===row),updates)};ctx.logUsage_=(...x)=>events.push(x);ctx.hash_=s=>'hashed:'+s;ctx.newToken_=()=> 'new-session';
function reset(){events=[];actor={user_id:'driver',display_name:'Driver',_row:1,salt:'s',pin_hash:'hashed:s:1234'};records={Trips:[{_row:1,trip_id:'t',driver_user_id:'driver',status:'open',depart_at:'2099-01-01T10:00:00Z',seats_taken:2,seats_total:3}],Requests:[{_row:1,request_id:'r',trip_id:'t',rider_user_id:'rider',status:'approved'},{_row:2,request_id:'r2',trip_id:'t',status:'pending'}],Users:[actor]}}
const edit={origin:'Potsdam',destination:'Syracuse',departLocal:'2099-02-01T12:00',seatsTotal:3};
reset();actor.user_id='other';assert.equal(ctx.apiEditTrip('x','t',edit).code,'NOT_OWNER');assert.equal(ctx.apiDeleteTrip('x','t').code,'NOT_OWNER');assert(!locked);
reset();assert.equal(ctx.apiEditTrip('x','t',{...edit,seatsTotal:1}).code,'BAD_TRIP');assert.equal(ctx.apiEditTrip('x','t',{...edit,seatsTotal:2.5}).code,'BAD_TRIP');assert.equal(ctx.apiEditTrip('x','t',edit).ok,true);assert.equal(records.Trips[0].seats_taken,2);
reset();assert.equal(ctx.apiDeleteTrip('x','t').ok,true);assert.equal(records.Trips[0].status,'deleted');assert.equal(records.Trips[0].seats_taken,0);assert(records.Requests.every(r=>r.status==='cancelled'));assert(!locked);
reset();records.Trips[0].status='cancelled';assert.equal(ctx.apiDecideRequest('x','r2','approve').code,'NOT_OPEN');
reset();records.Trips[0].seats_taken=3;assert.equal(ctx.apiDecideRequest('x','r2','approve').code,'TRIP_FULL');assert.equal(records.Requests[1].status,'pending');
reset();assert.equal(ctx.apiChangePin('x','bad','9876').code,'BAD_PIN');assert.equal(ctx.apiChangePin('x','1234','9876').ok,true);assert.equal(actor.pin_hash,'hashed:salt:9876');assert.equal(actor.token_hash,'hashed:new-session');assert(!locked);
reset();actor=null;assert.equal(ctx.apiEditTrip('','t',edit).code,'AUTH');assert.equal(ctx.apiDeleteTrip('','t').code,'AUTH');assert.equal(ctx.apiChangePin('','1234','9876').code,'AUTH');
new Function(fs.readFileSync('apps-script/Index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1]);
console.log('PASS: ownership, authentication, edit capacity, integer seats, soft deletion, request cancellation, closed/full trip approval, PIN verification/rotation, lock release, frontend syntax');
