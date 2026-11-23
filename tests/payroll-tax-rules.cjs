const assert = require('node:assert/strict');
const { calculate, covers, states, indianaCounties, kentuckyLocalities } = require('../payroll-tax-rules.js');
const profile = {
  state:'KY', periods:52, federalForm:'current', filingStatus:'single', multipleJobs:false, legacyAllowances:0,
  credits:0, otherIncome:0, deductions:0, federalExtra:0, federalExemptYear:2026, stateTreatment:'regular',
  stateExemptYear:2026, stateExtra:0, locality:'none', localityName:'', localExtra:0, elections:{}
};
function estimate(gross, settings = {}, check = {}) {
  return calculate({...profile,...settings},{ date:'2026-11-27', periodStartsOn:'2026-11-15', grossPay:gross,
    stateWages:gross,localWages:gross,federalWages:gross,socialSecurityWages:gross,medicareWages:gross,
    socialSecurityYtd:0,medicareYtd:0,...check});
}
const deductions = (gross,settings,check) => estimate(gross,settings,check).employee.map(row=>row.amount);
assert.equal(Object.keys(states).length,51);
assert.equal(indianaCounties.length,92);
assert.equal(new Set(indianaCounties.map(row=>row[0])).size,92);
assert.equal(Object.keys(kentuckyLocalities).length,5);
assert.deepEqual(deductions(1000),[78.08,32.74,0,62,14.5,0]);
assert.equal(deductions(1000,{ credits:2200, federalExtra:10 })[0], 45.77);
assert.equal(deductions(1000,{ multipleJobs:true })[0], 135.10);
assert.equal(deductions(1000,{ federalForm:'legacy',legacyAllowances:2 })[0],78.08);
assert.equal(deductions(1000,{ federalForm:'exempt' })[0],0);
assert.equal(deductions(1000,{ federalForm:'exempt',federalExemptYear:2025 })[0],null);
assert.equal(deductions(1000,{ federalForm:'special' })[0],null);
assert.equal(deductions(3270,{ periods:12 })[1],104.65);
assert.equal(deductions(1500,{ periods:26 })[1],47.98);
assert.equal(deductions(1000,{ locality:'louisvilleResident' })[2],22);
assert.equal(deductions(1000,{ locality:'louisvilleNonresident' })[2],14.5);
assert.equal(deductions(1000,{ locality:'lexington' })[2],22.5);
assert.equal(deductions(1000,{ locality:'elizabethtown' })[2],19.5);
assert.equal(deductions(1000,{ locality:'bardstown' })[2],10);
const indiana = { state:'IN',locality:'in:31',elections:{ inPersonal:5,inDependent:3,inFirst:1,inAdopted:2 } };
assert.deepEqual(deductions(800,indiana).slice(1,3),[13.96,4.73]);
assert.deepEqual(deductions(800,indiana,{date:'2026-10-09', periodStartsOn:'2026-09-29'}).slice(1,3),[13.96,null]);
assert.deepEqual(deductions(800,indiana,{date:'2026-10-09', periodStartsOn:'2026-10-01'}).slice(1,3),[13.96,4.73]);
assert.equal(deductions(1000,{state:'CA',locality:'unverified'})[1],null);
const noStateIncome = ['AK','FL','NV','NH','SD','TN','TX','WA','WY'];
for (const state of noStateIncome) {
  assert.equal(deductions(1000,{state})[1],0);
  assert.equal(covers(state),true);
}
assert.equal(deductions(1000,{state:'AZ',elections:{azRate:2.5},stateExtra:5})[1],30);
assert.equal(deductions(1000,{state:'CO',elections:{coStatus:'joint'}})[1],34.69);
assert.equal(deductions(1000,{state:'CO',elections:{coStatus:'certificate',coAllowance:0}})[1],44);
assert.equal(deductions(1000,{state:'IL',elections:{ilBase:1,ilAdditional:1}})[1],45.76);
assert.equal(deductions(1000,{state:'MI',elections:{miAllowances:1}})[1],37.68);
assert.equal(deductions(35000/12,{state:'MO',periods:12,elections:{moStatus:'single'}})[1],59);
assert.equal(deductions(450,{state:'NC',elections:{ncStatus:'standard',ncAllowances:2}})[1],4);
assert.equal(deductions(1000,{state:'PA'})[1],30.70);
assert.equal(deductions(1200,{state:'UT',periods:24,elections:{utStatus:'married'}})[1],18);
assert.equal(deductions(400,{state:'UT',elections:{utStatus:'single'}})[1],12);
assert.equal(deductions(400,{state:'UT',elections:{utStatus:'single'}},{date:'2026-06-04', periodStartsOn:'2026-05-31'})[1],null);
assert.equal(deductions(400,{state:'UT',elections:{utStatus:'single'}},{date:'2026-06-04', periodStartsOn:'2026-06-01'})[1],12);
const newYorkElections = { nyStatus:'single',nyAllowances:3,nyCityAllowances:3 };
assert.deepEqual(deductions(400,{state:'NY',locality:'newYorkCity',elections:newYorkElections}).slice(1,3),[8.01,6.11]);
assert.equal(deductions(50000,{state:'NY',periods:12,elections:newYorkElections})[1],3576.63);
assert.equal(deductions(100000,{state:'NY',periods:12,elections:newYorkElections})[1],10359.44);
assert.equal(deductions(2649,{state:'VA',periods:24,elections:{vaPersonal:5,vaAgeBlind:0}})[1],109.48);
assert.equal(deductions(2100,{state:'IA',periods:26,elections:{iaStatus:'standard',iaAllowance:40,iaLegacyCount:0}})[1],59.26);
assert.equal(deductions(5000,{state:'IA',periods:12,elections:{iaStatus:'joint',iaAllowance:80,iaLegacyCount:0}})[1],101);
assert.equal(deductions(2000,{state:'GA',periods:24,elections:{gaStatus:'joint',gaDependents:1}})[1],27.03);
assert.equal(deductions(2000,{state:'GA',periods:24,elections:{gaStatus:'joint',gaDependents:1}},{date:'2026-05-10',periodStartsOn:''})[1],null);
assert.equal(deductions(1000,{state:'MA',elections:{maAllowances:1,maHead:0,maBlind:0}},{maContributions:76.5})[1],41.93);
assert.equal(deductions(1000,{state:'MA',elections:{maAllowances:1,maHead:0,maBlind:0}})[1],null);
assert.deepEqual(deductions(2000,{}, {socialSecurityYtd:184200,medicareYtd:199500}).slice(3),[18.60,29,13.50]);
assert.deepEqual(estimate(2000,{}, {socialSecurityYtd:184200,medicareYtd:199500}).employer.map(r=>r.amount),[18.60,29]);
assert.deepEqual(deductions(2000,{}, {date:'2027-01-01', periodStartsOn:'2026-12-22'}),[null,null,null,null,null,null]);
assert.throws(()=>deductions(2000,{}, {date:'2026-02-31', periodStartsOn:''}));
assert.throws(()=>deductions(2000,{}, {periodStartsOn:'2026-11-28'}));
assert.throws(()=>deductions(2000,{}, {medicareYtd:NaN}));
console.log('Payroll calculations passed federal/W-4, all supported state cases, official examples, city and county rates, date boundaries, and FICA caps.');
