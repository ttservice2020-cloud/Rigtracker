const payrollTaxRules = (() => {
  'use strict';
  const { states, indianaCounties } = typeof module === 'undefined'
    ? payrollTaxJurisdictions : require('./payroll-tax-jurisdictions.js');

  const { nys, nyc } = typeof module === 'undefined' ? payrollTaxNewYork : require('./payroll-tax-new-york.js');
  const sources = {
    federal: 'https://www.irs.gov/publications/p15t',
    fica: 'https://www.irs.gov/publications/p15',
    noState: 'https://mn.gov/mmb/assets/20260916a_tcm1059-768126.pdf',
    IA: 'https://revenue.iowa.gov/media/53/download?inline=',
    GA: 'https://dor.georgia.gov/document/document/2026-employers-tax-guide-updated-september-2026/download',
    MA: 'https://www.mass.gov/doc/massachusetts-circular-m-income-tax-withholding-tables-at-50-effective-january-1-2026/download',
    NY: 'https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nys.pdf',
    nyc: 'https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nyc.pdf',
    VA: 'https://www.tax.virginia.gov/sites/default/files/vatax-pdf/employer-withholding-instructions.pdf',
    NH: 'https://www.revenue.nh.gov/taxes-glance/interest-and-dividends-tax',
    CO: 'https://tax.colorado.gov/sites/tax/files/documents/DR_1098_Colorado_Withholding_Worksheet_for_Employees.pdf',
    MI: 'https://www.michigan.gov/taxes/business-taxes/withholding/calendar-year-tax-information',
    MO: 'https://dor.mo.gov/forms/Withholding%20Formula_2026.pdf',
    UT: 'https://files.tax.utah.gov/tax/forms/pubs/pub-14.pdf',
    AZ: 'https://azdor.gov/sites/default/files/document/FORMS_WITHHOLDING_2026_A-4_f.pdf',
    IL: 'https://tax.illinois.gov/forms/withholding/currentyear/il-700-t-withholding-guide-tables.html',
    IN: 'https://www.in.gov/dor/files/dn01.pdf',
    KY: 'https://revenue.ky.gov/Forms/2026%20Withholding%20Formula.pdf',
    NC: 'https://www.ncdor.gov/income-tax-withholding-tables-and-instructions-employers/open',
    PA: 'https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/employer-withholding',
    lexington: 'https://www.lexingtonky.gov/working/business-licensing-taxes/occupational-license-fee-rates-current-forms',
    elizabethtown: 'https://www.elizabethtownky.org/government/departments/finance/business_licenses.php',
    bardstown: 'https://www.cityofbardstown.org/document_center/Licensing%20and%20Permits/Occupational%20License%20Fee%20Form.pdf',
    louisville: 'https://louisvilleky.gov/government/revenue-commission/w-1-tax-form-instructions'
  };
  const noStateIncomeTax = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);
  const schedules = [
    {
      single: [[7500,0], [19900,1240], [57900,5800], [113200,17966], [209275,41024], [263725,58448], [648100,192979.25]],
      married: [[19300,0], [44100,2480], [120100,11600], [230700,35932], [422850,82048], [531750,116896], [788000,206583.50]],
      head: [[15550,0], [33250,1770], [83000,7740], [121250,16155], [217300,39207], [271750,56631], [656150,191171]]
    },
    {
      single: [[8050,0], [14250,620], [33250,2900], [60900,8983], [108938,20512], [136163,29224], [328350,96489.63]],
      married: [[16100,0], [28500,1240], [66500,5800], [121800,17966], [217875,41024], [272325,58448], [400450,103291.75]],
      head: [[12075,0], [20925,885], [45800,3870], [64925,8077.50], [112950,19603.50], [140175,28315.50], [332375,95585.50]]
    }
  ];
  const federalRates = [.10,.12,.22,.24,.32,.35,.37];
  const periods = { 52:'Weekly', 26:'Every two weeks', 24:'Twice a month', 12:'Monthly' };
  const arizonaElections = [0, .5, 1, 1.5, 2, 2.5, 3, 3.5];
  const kentuckyLocalities = {
    louisvilleResident: ['Louisville Metro / Jefferson County · resident', .022, sources.louisville],
    louisvilleNonresident: ['Louisville Metro / Jefferson County · nonresident', .0145, sources.louisville],
    lexington: ['Lexington-Fayette occupational license fee', .0225, sources.lexington],
    elizabethtown: ['City of Elizabethtown occupational tax', .0195, sources.elizabethtown],
    bardstown: ['City of Bardstown occupational tax', .01, sources.bardstown]
  };
  const statusChoices = [['single','Single or married filing separately'], ['married','Married']];
  const baseFields = {
    GA: [['gaStatus','Form G-4 withholding status',[
      ['standard','Single, head of household, married filing separately or both spouses working'],
      ['joint','Married filing jointly with one spouse working']]],
      ['gaDependents','G-4 dependent allowances']],
    IA: [['iaStatus','IA W-4 withholding status',[
      ['standard','Other or married with both spouses working'], ['head','Head of household'],
      ['joint','Married with one spouse working or qualifying surviving spouse'],
      ['oldSingle','2023 or earlier form · single or legally separated'], ['oldMarried','2023 or earlier form · married']]],
      ['iaAllowance','IA W-4 total annual withholding allowance',null,'money'],
      ['iaLegacyCount','Number of allowances on 2023 or earlier IA W-4']],
    MA: [['maAllowances','Form M-4 total exemptions (including spouse allowance)'],
      ['maHead','Head of household on Form M-4',[[0,'No'],[1,'Yes']]],
      ['maBlind','Blindness exemptions (employee and spouse)',[[0,'0'],[1,'1'],[2,'2']]]],
    NY: [['nyStatus','IT-2104 withholding status',statusChoices], ['nyAllowances','IT-2104 line 1 state allowances'],
      ['nyCityAllowances','IT-2104 line 2 New York City allowances']],
    VA: [['vaPersonal','VA-4 personal and dependent exemptions'], ['vaAgeBlind','VA-4 age 65 or blindness exemptions']],
    CO: [['coStatus','Colorado filing status',[
      ['standard','Single, married filing separately or head of household'], ['joint','Married filing jointly or qualifying surviving spouse'],
      ['certificate','DR 0004 annual allowance entered below']
    ]], ['coAllowance','DR 0004 line 2 annual withholding allowance',null,'money']],
    MI: [['miAllowances','MI-W4 personal and dependency exemptions']],
    MO: [['moStatus','MO W-4 withholding status',[
      ['single','Single, married and spouse works, or married filing separately'], ['joint','Married and spouse does not work'],
      ['head','Head of household']
    ]]],
    UT: [['utStatus','Utah calculation status',statusChoices]],
    AZ: [['azRate', 'Arizona A-4 rate', arizonaElections.map(rate => [rate, rate + '%'])]],
    IL: [['ilBase','IL-W-4 line 1 allowances'], ['ilAdditional','IL-W-4 line 2 allowances']],
    IN: [['inPersonal','WH-4 line 5 personal exemptions'], ['inDependent','WH-4 line 6 dependent exemptions'],
      ['inFirst','WH-4 line 7 first-time dependent exemptions'], ['inAdopted','WH-4 line 8 adopted child exemptions']],
    NC: [['ncStatus','NC-4 filing status',[['standard','Single, married or surviving spouse'], ['head','Head of household']]],
      ['ncAllowances','NC-4 withholding allowances']]
  };

  const utahSchedules = {
    52:[[9,180],[19,360]], 26:[[19,360],[37,719]],
    24:[[20,390],[40,779]], 12:[[40,779],[81,1558]]
  };
  const missouriRates = [0,.02,.025,.03,.035,.04,.045,.047];
  const virginiaBrackets = [[0,.02,0],[3000,.03,60],[5000,.05,120],[17000,.0575,720]];
  // NYS-50-T-NYS and NYS-50-T-NYC Table B deductions and Table C exemptions.
  const newYorkDeductions = {
    52:[142.30,152.90,96.15,105.75,19.25], 26:[284.60,305.80,192.30,211.50,38.50],
    24:[308.35,331.25,208.35,229.15,41.65], 12:[616.70,662.50,416.70,458.30,83.30]
  };

  function bracketTax(wages, brackets) {
    const [floor,rate,base] = brackets.findLast(([floor]) => wages >= floor);
    return base + (wages - floor) * rate;
  }

  function newYorkWithholding(wages, count, elections, city) {
    const { nyStatus, nyAllowances, nyCityAllowances } = elections;
    const married = nyStatus === 'married';
    const deductions = newYorkDeductions[count];
    const standard = deductions[(city ? 2 : 0) + Number(married)];
    const net = Math.max(0,round(wages - standard - (city ? nyCityAllowances : nyAllowances) * deductions[4]));
    const annual = net * count;
    if (!city && annual >= (married ? 2155350 : 1077550)) {
      return net * (annual >= 25000000 ? .117 : annual >= 5000000 ? .111 : .1045);
    }
    return bracketTax(net,city ? nyc.single[count] : nys[nyStatus][count]);
  }

  function covers(state) {
    return noStateIncomeTax.has(state) || Object.hasOwn(sources, state) && Object.hasOwn(states, state);
  }

  function round(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function federalIncome(date, profile, wages, count) {
    if (!date.startsWith('2026-') || profile.federalForm === 'special') return null;
    if (profile.federalForm === 'exempt') {
      return profile.federalExemptYear === 2026 ? 0 : null;
    }
    const legacy = profile.federalForm === 'legacy';
    const brackets = schedules[!legacy && profile.multipleJobs ? 1 : 0][profile.filingStatus];
    if (!brackets || (legacy && profile.filingStatus === 'head') ||
      (!legacy && profile.federalForm !== 'current')) return null;
    const adjustment = profile.multipleJobs ? 0 : profile.filingStatus === 'married' ? 12900 : 8600;
    const annual = legacy
      ? wages * count - 4300 * profile.legacyAllowances
      : wages * count + profile.otherIncome - profile.deductions - adjustment;
    const index = brackets.findLastIndex(([floor]) => annual >= floor);
    const tentative = index < 0 ? 0 : brackets[index][1] + (annual - brackets[index][0]) * federalRates[index];
    return round(Math.max(0, (tentative - (legacy ? 0 : profile.credits)) / count) + profile.federalExtra);
  }

  function fica(date, input) {
    if (!date.startsWith('2026-')) return [null, null, null];
    const { socialSecurityWages, socialSecurityYtd, medicareWages, medicareYtd } = input;
    const ssTaxable = Math.min(socialSecurityWages, Math.max(0, 184500 - socialSecurityYtd));
    const regularMedicare = round(medicareWages * .0145);
    const additionalTaxable = Math.min(medicareWages, Math.max(0, medicareYtd + medicareWages - 200000));
    return [round(ssTaxable * .062), regularMedicare, round(additionalTaxable * .009)];
  }

  function indianaTaxable(elections, wages, count) {
    const exemptions = [
      elections.inPersonal * 1000, elections.inDependent * 1500,
      elections.inFirst * 1500, elections.inAdopted * 3000
    ];
    return Math.max(0, wages - exemptions.reduce((total, allowance) => total + round(allowance / count), 0));
  }

  function missouriIncome(wages, count, status) {
    const deduction = status === 'joint' ? 32200 : status === 'head' ? 24150 : 16100;
    const annual = Math.max(0,wages * count - deduction);
    const tax = missouriRates.reduce((amount,rate,index) => {
      const bracket = Math.max(0,annual - index * 1348);
      return amount + rate * (index === missouriRates.length - 1 ? bracket : Math.min(1348,bracket));
    },0);
    return Math.round(tax / count);
  }

  function utahIncome(wages,count,status) {
    const [allowance,threshold] = utahSchedules[count][status === 'married' ? 1 : 0];
    const reduction = Math.round(Math.max(0,wages - threshold) * .013);
    return Math.max(0,Math.round(wages * .0445) - Math.max(0,allowance - reduction));
  }

  const massachusettsPeriods = {
    // Value of factor for one exemption, increment and base for more, credits, low-wage minimum.
    52:[85,19,66,2.31,2.12,154], 26:[169,38,131,4.62,4.23,308],
    24:[183,42,141,5,4.58,333], 12:[367,83,284,10,9.17,667]
  };

  function massachusettsIncome(wages,count,elections,contributions) {
    if (!Number.isFinite(contributions) || contributions < 0 || contributions > 2000) return null;
    const { maAllowances, maHead, maBlind } = elections;
    const [one,increment,base,headCredit,blindCredit,minimum] = massachusettsPeriods[count];
    if (maAllowances > 0 && wages < minimum) return 0;
    const exempt = maAllowances === 0 ? 0 : maAllowances === 1 ? one : base + increment * maAllowances;
    const annual = Math.max(0,(wages - contributions - exempt) * count);
    const tax = annual * .05 + Math.max(0,annual - 1107750) * .04;
    return Math.max(0,tax / count - maHead * headCredit - maBlind * blindCredit);
  }

  function stateIncome(date, profile, wages, count, periodStartsOn, maContributions) {
    const { state, elections, stateTreatment, stateExtra } = profile;
    if (!date.startsWith('2026-') || !covers(state) || stateTreatment === 'review') return null;
    if (noStateIncomeTax.has(state)) return 0;
    if (state === 'UT' && (!periodStartsOn || periodStartsOn < '2026-06-01')) return null;
    if (state === 'GA' && date < '2026-05-11') return null;
    if (stateTreatment === 'exempt') return profile.stateExemptYear === 2026 ? 0 : null;
    let amount;
    switch (state) {
      case 'GA': {
        const standard = round((elections.gaStatus === 'joint' ? 30000 : 15000) / count);
        amount = Math.max(0,wages - standard - round(5000 / count) * elections.gaDependents) * .0499;
        break;
      }
      case 'IA': {
        const old = elections.iaStatus.startsWith('old');
        const annual = ['joint','oldMarried'].includes(elections.iaStatus) ? 26000 : elections.iaStatus === 'head' ? 19500 : 13000;
        const allowances = old ? 40 * elections.iaLegacyCount : elections.iaAllowance;
        amount = Math.max(0,round((wages - round(annual / count)) * .038) - round(allowances / count));
        break;
      }
      case 'MA': amount = massachusettsIncome(wages,count,elections,maContributions); break;
      case 'NY': amount = newYorkWithholding(wages,count,elections,false); break;
      case 'VA': {
        const annual = Math.max(0,wages * count - 8750 - 930 * elections.vaPersonal - 800 * elections.vaAgeBlind);
        amount = bracketTax(annual,virginiaBrackets) / count;
        break;
      }
      case 'CO': {
        const deduction = elections.coStatus === 'certificate' ? elections.coAllowance : elections.coStatus === 'joint' ? 11000 : 5500;
        amount = Math.max(0,wages - deduction / count) * .044;
        break;
      }
      case 'MI': amount = Math.max(0,wages - elections.miAllowances * 5900 / count) * .0425; break;
      case 'MO': amount = missouriIncome(wages,count,elections.moStatus); break;
      case 'UT': amount = utahIncome(wages,count,elections.utStatus); break;
      case 'AZ': amount = wages * elections.azRate / 100; break;
      case 'IL': amount = Math.max(0, wages - (elections.ilBase * 2925 + elections.ilAdditional * 1000) / count) * .0495; break;
      case 'IN': amount = indianaTaxable(elections, wages, count) * .0295; break;
      case 'KY': amount = Math.max(0, wages - 3360 / count) * .035; break;
      case 'NC': {
        const deduction = elections.ncStatus === 'head' ? 19125 : 12750;
        amount = Math.round(Math.max(0, wages - (deduction + 2500 * elections.ncAllowances) / count) * .0409);
        break;
      }
      case 'PA': amount = wages * .0307; break;
      default: return null;
    }
    return amount === null ? null : round(round(amount) + stateExtra);
  }

  function localIncome(date, profile, wages, count, periodStartsOn) {
    const { state, locality, elections, localExtra } = profile;
    if (!date.startsWith('2026-')) return { amount:null };
    if (locality === 'none') return { amount:0, name:'Local income tax (none applies)' };
    if (locality === 'unverified') return { amount:null, name:profile.localityName || 'City / county income tax' };
    if (state === 'KY' && Object.hasOwn(kentuckyLocalities,locality)) {
      const [name,rate,source] = kentuckyLocalities[locality];
      return { amount:round(wages * rate), name, source };
    }
    if (state === 'NY' && locality === 'newYorkCity') {
      return { amount:round(round(newYorkWithholding(wages,count,elections,true)) + localExtra),
        name:'New York City resident income tax', source:sources.nyc };
    }
    if (state === 'IN' && locality.startsWith('in:')) {
      const county = indianaCounties.find(([code]) => 'in:' + code === locality);
      if (county && periodStartsOn >= '2026-10-01') return {
        amount:round(round(indianaTaxable(elections,wages,count) * county[2]) + localExtra),
        name:county[1] + ' County, IN', source:sources.IN
      };
      return { amount:null, name:county ? county[1] + ' County, IN' : 'Indiana county tax', source:sources.IN };
    }
    return { amount:null };
  }

  function validDate(date) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date;
  }

  function calculate(profile, input) {
    const { date, periodStartsOn, federalWages, stateWages, localWages } = input;
    if (!validDate(date) || !Object.hasOwn(periods, profile.periods) || !Object.hasOwn(states, profile.state)) {
      throw new Error('Choose a valid pay date and save the employee’s pay frequency and withholding state.');
    }
    if (periodStartsOn && (!validDate(periodStartsOn) || periodStartsOn > date)) {
      throw new Error('The pay period must start on or before the pay date.');
    }
    const required = ['grossPay','federalWages','stateWages','localWages','socialSecurityWages','medicareWages',
      'socialSecurityYtd','medicareYtd'];
    if (!required.every(key => Number.isFinite(input[key]) && input[key] >= 0)) {
      throw new Error('Enter each wage amount and both year-to-date totals. Enter 0 where applicable.');
    }
    const local = localIncome(date, profile, localWages, profile.periods, periodStartsOn);
    const [socialSecurity, medicare, additionalMedicare] = fica(date, input);
    const employee = [
      { name:'Federal income tax', amount:federalIncome(date, profile, federalWages, profile.periods), source:sources.federal },
      { name:states[profile.state][0] + ' income tax', amount:stateIncome(date,profile,stateWages,profile.periods,periodStartsOn,input.maContributions),
        source:sources[profile.state] || (noStateIncomeTax.has(profile.state) ? sources.noState : states[profile.state][1]) },
      { name:local.name || 'City / county income tax', amount:local.amount, source:local.source },
      { name:'Social Security', amount:socialSecurity, source:sources.fica },
      { name:'Medicare', amount:medicare, source:sources.fica },
      { name:'Additional Medicare', amount:additionalMedicare, source:sources.fica }
    ];
    if (employee.some(row => row.amount !== null && (!Number.isFinite(row.amount) || row.amount < 0))) {
      throw new Error('Review the withholding elections and save the employee’s tax profile again.');
    }
    return { employee, employer:[
      { name:'Employer Social Security', amount:socialSecurity, source:sources.fica },
      { name:'Employer Medicare', amount:medicare, source:sources.fica }
    ] };
  }

  return { states, indianaCounties, kentuckyLocalities, sources, covers, periods, baseFields, calculate };
})();

if (typeof module !== 'undefined') module.exports = payrollTaxRules;
