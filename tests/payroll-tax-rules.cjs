const assert = require('node:assert/strict');
const {
  calculate, covers, states, indianaCounties, kentuckyLocalities, baseFields, marylandLocalities, ohioDistricts, percentOfWages
} = require('../payroll-tax-rules.js');
const stateFormulas = require('../payroll-tax-state-formulas.js');
const { stateWageBase, unemployment, federalGarnishmentLimit, payAmounts } = require('../payroll-tax-deductions.js');
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
assert.deepEqual(deductions(800,indiana,{date:'2026-10-09', periodStartsOn:'2026-09-29'}).slice(1,3),[13.96,4.73]);
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
assert.equal(deductions(2000,{state:'UT',elections:{utStatus:'single'}},{date:'2026-06-04', periodStartsOn:'2026-05-31'})[1],90);
assert.equal(deductions(2000,{state:'UT',elections:{utStatus:'single'}},{date:'2026-06-04', periodStartsOn:'2026-06-01'})[1],89);
assert.equal(deductions(400,{state:'UT',elections:{utStatus:'single'}},{date:'2026-06-04', periodStartsOn:''})[1],null);
assert.equal(deductions(400,{state:'UT',elections:{utStatus:'single'}},{date:'2026-06-04', periodStartsOn:'2026-06-01'})[1],12);
const newYorkElections = { nyStatus:'single',nyAllowances:3,nyCityAllowances:3 };
assert.deepEqual(deductions(400,{state:'NY',locality:'newYorkCity',elections:newYorkElections}).slice(1,3),[8.01,6.11]);
assert.equal(deductions(50000,{state:'NY',periods:12,elections:newYorkElections})[1],3576.63);
assert.equal(deductions(100000,{state:'NY',periods:12,elections:newYorkElections})[1],10359.44);
assert.equal(deductions(2649,{state:'VA',periods:24,elections:{vaPersonal:5,vaAgeBlind:0}})[1],109.48);
assert.equal(deductions(2100,{state:'IA',periods:26,elections:{iaStatus:'standard',iaAllowance:40,iaLegacyCount:0}})[1],59.26);
assert.equal(deductions(5000,{state:'IA',periods:12,elections:{iaStatus:'joint',iaAllowance:80,iaLegacyCount:0}})[1],101);
assert.equal(deductions(2000,{state:'GA',periods:24,elections:{gaStatus:'joint',gaDependents:1}})[1],27.03);
assert.equal(deductions(2000,{state:'GA',periods:24,elections:{gaStatus:'joint',gaDependents:1}},{date:'2026-05-10',periodStartsOn:''})[1],43.25);
assert.equal(deductions(1000,{state:'MA',elections:{maAllowances:1,maHead:0,maBlind:0}},{maContributions:76.5})[1],41.93);
assert.equal(deductions(1000,{state:'MA',elections:{maAllowances:1,maHead:0,maBlind:0}})[1],null);
assert.deepEqual(deductions(2000,{}, {socialSecurityYtd:184200,medicareYtd:199500}).slice(3),[18.60,29,13.50]);
assert.deepEqual(estimate(2000,{}, {socialSecurityYtd:184200,medicareYtd:199500}).employer.map(r=>r.amount),[18.60,29]);
assert.deepEqual(deductions(2000,{}, {date:'2027-01-01', periodStartsOn:'2026-12-22'}),[null,null,null,null,null,null]);
assert.throws(()=>deductions(2000,{}, {date:'2026-02-31', periodStartsOn:''}));
assert.throws(()=>deductions(2000,{}, {periodStartsOn:'2026-11-28'}));
assert.throws(()=>deductions(2000,{}, {medicareYtd:NaN}));

for (const state of Object.keys(states)) {
  assert.equal(covers(state),true,state);
  const elections = Object.fromEntries((baseFields[state] || []).map(([name,,choices]) => [name,choices ? choices.at(-1)[0] : 0]));
  if (state === 'AR') elections.arMethod = 'standard';
  for (const periods of [52,26,24,12]) {
    const gross = 120000 / periods;
    const amount = deductions(gross,{state,periods,elections},{maContributions:0})[1];
    assert.equal(Number.isFinite(amount),true,state + ' ' + periods);
    assert.equal(amount === 0,noStateIncome.includes(state),state);
  }
}

// Examples from the respective agencies' payroll withholding instructions.
const stateExamples = [
  ['AL',850,52,{alStatus:'married',alDependents:2},29.59,35.19],
  ['AR',2127,12,{arExemptions:2,arMethod:'standard',arLowStatus:'single',arLowDependents:0},36.50],
  ['AR',282.70,52,{arExemptions:0,arMethod:'lowIncome',arLowStatus:'single',arLowDependents:1},.07],
  ['AR',336.55,52,{arExemptions:0,arMethod:'lowIncome',arLowStatus:'single',arLowDependents:0},null],
  ['CA',210,52,{caStatus:'single',caRegular:1,caDeduction:0},0],
  ['CA',1600,26,{caStatus:'married',caRegular:2,caDeduction:1},2.38],
  ['CA',5100,12,{caStatus:'married',caRegular:5,caDeduction:0},0.82],
  ['CA',950,52,{caStatus:'head',caRegular:3,caDeduction:0},1.69],
  ['HI',500,52,{hiStatus:'single',hiAllowances:3},9.58],
  ['ID',1000,52,{idStatus:'married',idAllowances:4},7,0,'2026-07-30'],
  ['ID',1000,52,{idStatus:'married',idAllowances:4},20,0,'2026-07-31'],
  ['KS',2000,24,{ksStatus:'married',ksPersonal:2,ksAllowances:1},41.44],
  ['LA',700,52,{laDeduction:1},13.98],
  ['LA',4600,26,{laDeduction:2},111.54],
  ['ME',1000,52,{meStatus:'single',meAllowances:2},32],
  ['ND',1800,52,{ndStatus:'oldSingle',ndAllowances:2},10],
  ['OH',2000,52,{ohExemptions:1},53.75,0,'2026-07-31'],
  ['OH',2000,52,{ohExemptions:1},52.73,0,'2026-08-01'],
  ['OR',25000/52,52,{orStatus:'single',orAllowances:0},34,1000/52],
  ['RI',2195,52,{riExemptions:1},87.57],
  ['SC',750,52,{scAllowances:3},10.58],
  ['WI',350,52,{wiStatus:'single',wiExemptions:1},7.59],
  ['WI',500,52,{wiStatus:'single',wiExemptions:3},14.34],
  ['WI',1000,26,{wiStatus:'married',wiExemptions:3},22.08]
];
for (const [state,wages,periods,elections,expected,federalAmount = 0,date = '2026-11-27'] of stateExamples) {
  assert.equal(stateFormulas.calculate(state,{date,wages,periods,elections,federalAmount,input:{}}),expected,state);
}
assert.equal(deductions(850,{state:'AL',federalForm:'special',elections:{alStatus:'married',alDependents:2}})[1],null);
assert.equal(deductions(1000,{state:'WV',elections:{wvStatus:'one',wvExemptions:1}},
  {date:'2026-06-11',periodStartsOn:'2026-06-01'})[1],null);

assert.equal(deductions(400,{state:'NY',locality:'yonkersResident',elections:newYorkElections})[2],1.34);
assert.equal(deductions(50000,{state:'NY',locality:'yonkersResident',periods:12,elections:newYorkElections})[2],599.08);
assert.equal(deductions(75,{state:'NY',locality:'yonkersNonresident',elections:newYorkElections})[2],0);
assert.equal(deductions(200,{state:'NY',locality:'yonkersNonresident',elections:newYorkElections})[2],0.81);
assert.equal(deductions(400,{state:'NY',locality:'yonkersNonresident',periods:24,elections:newYorkElections})[2],1.38);
assert.equal(deductions(1000,{state:'IN',locality:'in:06',elections:indiana.elections},
  {date:'2026-09-29',periodStartsOn:'2026-09-21'})[2],11.44);
assert.equal(deductions(1000,{state:'IN',locality:'in:06',elections:indiana.elections},
  {date:'2026-10-03',periodStartsOn:'2026-10-01'})[2],11.51);
assert.equal(Object.keys(marylandLocalities).length,25);
assert.deepEqual(deductions(1300,{state:'MD',locality:'md:04',elections:{mdStatus:'single',mdExemptions:1}}).slice(1,3),[55.72,37.54]);
assert.equal(Object.keys(ohioDistricts).length,214);
assert.equal(deductions(1000,{state:'OH',locality:'oh:0502',elections:{ohExemptions:2}})[2],10);
assert.equal(deductions(1000,{state:'OH',locality:'oh:2501',elections:{ohExemptions:2}})[2],7.31);
assert.equal(deductions(2000,{state:'PA',locality:'philadelphiaResident'},
  {date:'2026-06-30',periodStartsOn:'2026-06-25'})[2],74.80);
assert.equal(deductions(2000,{state:'PA',locality:'philadelphiaResident'},
  {date:'2026-07-01',periodStartsOn:'2026-06-25'})[2],74.70);
assert.equal(deductions(2000,{state:'PA',locality:'philadelphiaNonresident'})[2],68.50);
const localTaxes = [
  {name:'City tax',method:'rate',value:1.5,source:'https://example.gov/city'},
  {name:'School tax',method:'rate',value:.75}, {name:'Local fee',method:'fixed',value:2}
];
const localAmounts = estimate(1000,{locality:'configured',localTaxes},{localTaxWages:[undefined,800]})
  .employee.filter(row=>localTaxes.some(tax=>tax.name===row.name));
assert.deepEqual(localAmounts.map(row=>row.amount),[15,6,2]);
assert.equal(localAmounts[0].source,'https://example.gov/city');
assert.equal(deductions(1000,{locality:'unverified',localTaxes})[2],null);
for (const state of Object.keys(states)) assert.ok(stateWageBase(state,2026),state);
assert.equal(stateWageBase('KY',2026),12000);
assert.equal(stateWageBase('NV',2026),43700);
assert.deepEqual(stateWageBase('RI',2026),[30800,32300]);
assert.equal(stateWageBase('KY',2027),undefined);
assert.equal(unemployment(1200,6500,7000,.6),3);
assert.equal(unemployment(1200,12000,12000,2.7),0);
assert.equal(unemployment(1200,11600,12000,2.7),10.8);
assert.throws(() => unemployment(1200,NaN,7000,2.7));
assert.equal(federalGarnishmentLimit(52,200,'ordinary'),0);
assert.equal(federalGarnishmentLimit(52,233,'ordinary'),15.50);
assert.equal(federalGarnishmentLimit(52,370,'ordinary'),92.50);
assert.equal(federalGarnishmentLimit(12,1000,'ordinary'),57.50);
assert.equal(federalGarnishmentLimit(52,800,'support',true,false),400);
assert.equal(federalGarnishmentLimit(52,800,'support',false,true),520);
assert.equal(percentOfWages(875.50,1.3),11.38);

const payItems = [{type:'bonus',amount:200},{type:'accountableReimbursement',amount:80}];
const pay = payAmounts(1000,payItems,[{amount:100,reduces:['federalWages']}]);
assert.equal(pay.grossPay,1280);
assert.equal(pay.taxableGross,1200);
assert.equal(pay.supplementalGross,200);
assert.equal(pay.wageBases.federalWages,1100);
assert.equal(pay.wageBases.socialSecurityWages,1200);
assert.equal(pay.wageBases.futaWages,1200);
assert.equal(payAmounts(1000,[{type:'overtimeRegular',amount:100},{type:'taxableReimbursement',amount:75}],
  [{amount:40,reduces:['socialSecurityWages','medicareWages','sutaWages']}]).wageBases.medicareWages,1135);
assert.equal(payAmounts(1000,payItems,[{amount:100,reduces:[]}]).wageBases.federalWages,1200);
assert.throws(() => payAmounts(0,[],[{amount:100,reduces:['federalWages']}]),/exceed/);

const supplemental = {gross:200,taxableGross:1200,ytd:0,method:'aggregate',separate:false,regularWithholding:false};
assert.deepEqual(deductions(1280,{}, {...pay.wageBases,supplemental}),[90.08,39.74,0,74.40,17.40,0]);
assert.throws(() => deductions(1280,{}, {...pay.wageBases,supplemental:{...supplemental,method:'flat',regularWithholding:true}}),/taxable portion/);
assert.throws(() => deductions(1200,{}, {supplemental:{...supplemental,method:'flat'}}),/Confirm federal/);
assert.equal(deductions(1280,{}, {...pay.wageBases,
  supplemental:{...supplemental,method:'flat',regularWithholding:true,taxable:200}})[0],110.08);
const separate = {gross:500,taxableGross:500,ytd:0,method:'aggregate',separate:true,priorWages:1000,priorWithheld:78.08};
assert.deepEqual(deductions(500,{locality:'lexington'},{supplemental:separate}).slice(0,3),[82.11,null,null]);
assert.throws(() => deductions(500,{}, {supplemental:{...separate,priorWages:NaN}}),/previously paid/);
const crossesCap = {gross:1000,taxableGross:1000,ytd:999900,method:'flat',separate:true,regularWithholding:true};
assert.equal(deductions(1000,{}, {supplemental:crossesCap})[0],355);
assert.equal(deductions(1000,{federalForm:'exempt'}, {supplemental:{...crossesCap,ytd:1000000,regularWithholding:false}})[0],370);
assert.deepEqual(deductions(80,{federalExtra:10,stateExtra:20},{reimbursementOnly:true,
  federalWages:0,stateWages:0,localWages:0,socialSecurityWages:0,medicareWages:0}),[0,0,0,0,0,0]);
console.log('Payroll calculations passed regular and supplemental pay, reimbursements, pre-tax deductions, local rates, and federal caps.');
