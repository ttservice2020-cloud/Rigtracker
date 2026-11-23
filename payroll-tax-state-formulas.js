const payrollTaxStateFormulas = (() => {
  'use strict';

  const arkansasLowTables = typeof module === 'undefined' ? payrollTaxArkansasLow : require('./payroll-tax-arkansas-low.js');
  const californiaTables = typeof module === 'undefined' ? payrollTaxCalifornia : require('./payroll-tax-california.js');
  const newJerseyTables = typeof module === 'undefined' ? payrollTaxNewJersey : require('./payroll-tax-new-jersey.js');
  const newMexicoTables = typeof module === 'undefined' ? payrollTaxNewMexico : require('./payroll-tax-new-mexico.js');
  const sources = {
    AR:'https://www.dfa.arkansas.gov/wp-content/uploads/Withholding-Tax-Formula.pdf',
    LA:'https://dam.ldr.la.gov/taxforms/1306-1-26.pdf',
    MD:'https://www.marylandcomptroller.gov/content/dam/mdcomp/tax/instructions/withholding/2026/withholding-guide.pdf',
    NM:'https://realfile.tax.newmexico.gov/FYI-104.pdf',
    OH:'https://dam.assets.ohio.gov/image/upload/tax.ohio.gov/employer_withholding/2026%20Withholding%20Tables/WHT_PercentageMethod_2026.pdf',
    VT:'https://help.nfc.usda.gov/bulletins/2026/1780320782.htm?taxmap=true',
    CA:'https://edd.ca.gov/siteassets/files/pdf_pub_ctr/26methb.pdf',
    CT:'https://portal.ct.gov/-/media/drs/publications/pubsip/2026/ip-2026-1.pdf',
    DC:'https://help.nfc.usda.gov/bulletins/2022/1668460546.htm?taxmap=true',
    DE:'https://revenue.delaware.gov/employers-guide-withholding-regulations-employers-duties/',
    ND:'https://www.tax.nd.gov/sites/www/files/documents/forms/individual/2026-iit/2026-income-tax-withholding-rates-booklet.pdf',
    NJ:'https://www.nj.gov/treasury/taxation/pdf/withholdingtables.pdf',
    OR:'https://www.oregon.gov/dor/forms/FormsPubs/withholding-tax-formulas_206-436_2026.pdf',
    AL:'https://www.revenue.alabama.gov/wp-content/uploads/2026/01/whbooklet_0126.pdf',
    HI:'https://files.hawaii.gov/tax/news/pubs/25BkltA.pdf',
    ID:'https://tax.idaho.gov/wp-content/uploads/pubs/EPB00744/EPB00744_07-23-2026.pdf',
    KS:'https://www.ksrevenue.gov/kw100.html',
    MS:'https://www.dor.ms.gov/sites/default/files/tax-forms/business/89700251revised1.13.2026.pdf',
    MT:'https://revenuefiles.mt.gov/files/Forms/Montana_Employer_and_Information_Agent_Guide_with_Tax_Tables.pdf',
    WV:'https://tax.wv.gov/Documents/Withholding/it100.2a.pdf',
    ME:'https://www1.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/26_wh_tab_instr_August2026.pdf',
    MN:'https://www.revenue.state.mn.us/sites/default/files/2025-12/wh-inst-26.pdf',
    NE:'https://revenue.nebraska.gov/sites/default/files/doc/business/Cir_En_2025/2026_percent.pdf',
    OK:'https://oklahoma.gov/content/dam/ok/en/tax/documents/resources/publications/businesses/withholding-tables/WHTables-2026.pdf',
    RI:'https://tax.ri.gov/sites/g/files/xkgbur541/files/2025-12/2026%20Withholding%20Tax%20Booklet.pdf',
    SC:'https://dor.sc.gov/sites/dor/files/forms/WH1603F_2026.pdf',
    WI:'https://www.revenue.wi.gov/DOR%20Publications/pb166.pdf'
  };

  const filingStatuses = [['single','Single or higher single rate'], ['married','Married']];
  const fields = {
    AR: [['arExemptions','AR4EC total withholding exemptions'],
      ['arMethod','Arkansas withholding method',[
        ['standard','Standard formula'], ['lowIncome','Employee elected low-income withholding tables']]],
      ['arLowStatus','AR4EC line 5 filing status',[
        ['single','Single'], ['married','Married filing jointly'], ['head','Head of household or qualifying surviving spouse']]],
      ['arLowDependents','AR4EC line 2 dependents for the low-income tables']],
    LA: [['laDeduction','Louisiana L-4 block A standard deduction',[
      [0,'0 · No standard deduction'], [1,'1 · Single or married separately'],
      [2,'2 · Married jointly, qualifying surviving spouse or head of household']]]],
    MD: [['mdStatus','MW507 withholding status',[
      ['single','Single, married at higher single rate, or dependent taxpayer'],
      ['married','Joint, head of household, or qualifying surviving spouse']]],
      ['mdExemptions','MW507 line 1 total withholding exemptions']],
    NM: [['nmStatus','W-4 withholding status for New Mexico',[
      ['single','Single or married filing separately'], ['married','Married filing jointly'],
      ['head','Head of household']]]],
    OH: [['ohExemptions','Ohio IT 4 total withholding exemptions']],
    VT: [['vtStatus','W-4VT withholding status',filingStatuses], ['vtAllowances','W-4VT withholding allowances'],
      ['vtFederalExtra','Use additional federal withholding from an older federal W-4',[[0,'No'],[1,'Yes']]]],
    CA: [['caStatus','DE 4 withholding status',[
      ['single','Single, dual-income married or married with multiple employers'],
      ['married','Married, one income'], ['head','Unmarried head of household']]],
      ['caRegular','DE 4 line 1a regular allowances'], ['caDeduction','DE 4 line 1b estimated deduction allowances']],
    CT: [['ctCode','CT-W4 line 1 withholding code',[
      ['A','A'], ['B','B'], ['C','C'], ['D','D'], ['F','F']]],
      ['ctReduction','CT-W4 line 3 reduction per pay period',null,'money']],
    DC: [['dcAllowances','Form D-4 withholding allowances']],
    DE: [['deStatus','DE W-4 withholding status',[
      ['single','Single or married filing separately'], ['married','Married filing jointly']]],
      ['deAllowances','DE W-4 withholding allowances']],
    ND: [['ndStatus','Federal W-4 status for North Dakota withholding',[
      ['single','2020 or later · Single or married filing separately'], ['married','2020 or later · Married filing jointly'],
      ['head','2020 or later · Head of household'], ['oldSingle','Before 2020 · Single'], ['oldMarried','Before 2020 · Married']]],
      ['ndAllowances','Number of pre-2020 W-4 allowances']],
    NJ: [['njRate','NJ-W4 withholding rate table',[
      ['A','Rate A · Single / married filing separately'], ['B','Rate B · Joint, head of household or surviving spouse'],
      ['C','Rate C'], ['D','Rate D'], ['E','Rate E']]],
      ['njAllowances','NJ-W4 line 4 withholding allowances']],
    OR: [['orStatus','OR-W-4 withholding status',[
      ['single','Single, head of household or married at the higher single rate'], ['married','Married rate'],
      ['noCertificate','No withholding statement or exemption certificate']]],
      ['orAllowances','OR-W-4 withholding allowances']],
    AL: [['alStatus','Alabama A-4 exemption status',[
      ['none','0 · No personal exemption'], ['single','S · Single'], ['separate','MS · Married filing separately'],
      ['married','M · Married filing jointly'], ['head','H · Head of family']]],
      ['alDependents','A-4 dependents other than spouse']],
    HI: [['hiStatus','HW-4 withholding status',filingStatuses], ['hiAllowances','HW-4 withholding allowances']],
    ID: [['idStatus','ID W-4 withholding status',filingStatuses],
      ['idAllowances','ID W-4 child credit allowances (checks before July 31, 2026)']],
    KS: [['ksStatus','K-4 withholding status',filingStatuses], ['ksPersonal','K-4 worksheet lines A and B allowances',[[0,'0'],[1,'1'],[2,'2']]],
      ['ksAllowances','K-4 worksheet line C dependent allowances']],
    MS: [['msStatus','Mississippi Form 89-350 withholding status',[
      ['none','No certificate'], ['single','Single'], ['head','Head of family'], ['married','Married']]],
      ['msExemption','Form 89-350 line 6 total exemptions',null,'money']],
    MT: [['mtStatus','MW-4 withholding status',[
      ['single','Line 1a or 2 · Single, married filing separately or both spouses work'],
      ['married','Line 1b · Married jointly or qualifying surviving spouse'], ['head','Line 1c · Head of household']]],
      ['mtPercent','MW-4 additional percentage of wages (%)',null,'percent']],
    WV: [['wvStatus','IT-104 withholding schedule',[
      ['one','Optional one earner / one job'], ['two','Two earners / two or more jobs']]],
      ['wvExemptions','IT-104 withholding exemptions']],
    ME: [['meStatus','W-4ME withholding status',filingStatuses], ['meAllowances','W-4ME withholding allowances']],
    MN: [['mnStatus','W-4MN withholding status',filingStatuses], ['mnAllowances','W-4MN withholding allowances']],
    NE: [['neStatus','W-4N withholding status',filingStatuses], ['neAllowances','W-4N withholding allowances']],
    OK: [['okStatus','OK-W-4 withholding status',filingStatuses], ['okAllowances','OK-W-4 withholding allowances']],
    RI: [['riExemptions','RI W-4 exemptions and allowances']],
    SC: [['scAllowances','SC W-4 withholding allowances']],
    WI: [['wiStatus','WT-4 withholding status',filingStatuses], ['wiExemptions','WT-4 withholding exemptions']]
  };

  const cents = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const annualExemption1000 = {52:19.23,26:38.46,24:41.67,12:83.33};

  function bracketTax(wages, brackets) {
    const row = brackets.findLast(([floor]) => wages >= floor);
    if (!row) return 0;
    const [floor, rate, base] = row;
    return base + (wages - floor) * rate;
  }

  function periodBrackets(wages, rates, table) {
    const [floors, bases] = table;
    const index = floors.findLastIndex(floor => wages >= floor);
    return index === -1 ? 0 : bases[index] + (wages - floors[index]) * rates[index];
  }

  function alabama({ wages, periods, elections, federalAmount }) {
    const { alStatus:status, alDependents } = elections;
    if (!Number.isFinite(federalAmount)) return null;
    const gross = wages * periods;
    const annual = Math.floor(gross);
    const [maximum, minimum, exemption, reduction] = {
      none:[3000,2500,0,25], single:[3000,2500,1500,25], separate:[4250,2500,1500,88],
      married:[8500,5000,3000,175], head:[5200,2500,3000,135]
    }[status];
    const lower = status === 'separate' ? 13000 : 26000;
    const upper = status === 'separate' ? 17750 : 35500;
    const deduction = annual >= upper ? minimum : annual < lower ? maximum
      : maximum - (1 + Math.floor((annual - lower) / (status === 'separate' ? 250 : 500))) * reduction;
    const dependentAllowance = gross <= 50000 ? 1000 : gross <= 100000 ? 500 : 300;
    const taxable = gross - deduction - exemption - federalAmount * periods - alDependents * dependentAllowance;
    const brackets = status === 'married' ? [[0,.02,0],[1000,.04,20],[6000,.05,220]]
      : [[0,.02,0],[500,.04,10],[3000,.05,110]];
    return bracketTax(taxable,brackets) / periods;
  }

  const minnesotaBrackets = {
    single:[[4700,.0535,0],[38010,.068,1782.09],[114130,.0785,6958.25],[207850,.0985,14315.27]],
    married:[[14700,.0535,0],[63400,.068,2605.45],[208180,.0785,12450.49],[352630,.0985,23789.82]]
  };

  // Circular EN tables 1–4 list rounded cutoffs and starting tax for each pay period.
  const nebraskaRates = [.0226,.0322,.0421,.0435,.0448,.046];
  const nebraskaTables = {
    52:[
      [[66,129,419,608,772,1449],[0,1.42,10.76,18.72,25.85,56.18]],
      [[158,250,623,969,1203,1595],[0,2.08,14.09,28.66,38.84,56.40]]
    ],
    26:[
      [[132,258,839,1216,1543,2899],[0,2.85,21.56,37.43,51.65,112.40]],
      [[315,500,1246,1938,2405,3189],[0,4.18,28.20,57.33,77.64,112.76]]
    ],
    24:[
      [[143,280,909,1317,1672,3140],[0,3.10,23.35,40.53,55.97,121.74]],
      [[341,542,1350,2100,2605,3455],[0,4.54,30.56,62.14,84.11,122.19]]
    ],
    12:[
      [[286,559,1818,2634,3344,6281],[0,6.17,46.71,81.06,111.95,243.53]],
      [[683,1084,2700,4200,5211,6910],[0,9.06,61.10,124.25,168.23,244.35]]
    ]
  };
  const nebraskaAllowance = {52:46.92,26:93.85,24:101.67,12:203.33};

  function nebraska({ wages, periods, elections }) {
    const married = elections.neStatus === 'married';
    const table = nebraskaTables[periods][Number(married)];
    const allowance = nebraskaAllowance[periods];
    const tentative = periodBrackets(wages - elections.neAllowances * allowance,nebraskaRates,table);
    const normal = periodBrackets(wages - (married ? 2 : 1) * allowance,nebraskaRates,table);
    return Math.max(tentative,Math.min(wages * .015,normal / 2));
  }

  const oklahomaRates = [.025,.035,.045];
  const oklahomaTables = {
    52:[[[194,216,261],[0,.55,2.10]],[[388,433,521],[0,1.11,4.20]]],
    26:[[[388,433,521],[0,1.11,4.20]],[[777,865,1042],[0,2.21,8.40]]],
    24:[[[421,469,565],[0,1.20,4.55]],[[842,938,1129],[0,2.40,9.10]]],
    12:[[[842,938,1129],[0,2.40,9.10]],[[1683,1875,2258],[0,4.79,18.21]]]
  };

  const rhodeIslandExemptionLimit = {52:5592.31,26:11184.62,24:12116.67,12:24233.33};
  const rhodeIslandTables = {
    52:[[0,1578,3586],[0,59.18,154.56]],
    26:[[0,3156,7171],[0,118.35,309.06]],
    24:[[0,3419,7769],[0,128.21,334.84]],
    12:[[0,6838,15538],[0,256.43,669.68]]
  };

  function maine({ wages, periods, elections }) {
    const annual = wages * periods;
    const married = elections.meStatus === 'married';
    const [standard, phaseOutEnd, phaseOutSpan] = married ? [28550,354550,150000] : [12850,177250,75000];
    const phaseOutFactor = Math.min(1,Math.max(0,Math.round((phaseOutEnd - annual) / phaseOutSpan * 10000) / 10000));
    const taxable = annual - standard * phaseOutFactor - elections.meAllowances * 5300;
    const brackets = married ? [[0,.058,0],[54850,.0675,3181],[129750,.0715,8237]]
      : [[0,.058,0],[27400,.0675,1589],[64850,.0715,4117]];
    // The revised 2026 instructions include the new high-income surcharge.
    const surcharge = .02 * Math.max(0,taxable - (married ? 1500000 : 1000000));
    return Math.round((bracketTax(taxable,brackets) + surcharge) / periods);
  }

  const hawaiiBrackets = {
    single:[[0,.014,0],[9600,.032,134],[14400,.055,288],[19200,.064,552],[24000,.068,859],
      [36000,.072,1675],[48000,.076,2539],[125000,.079,8391]],
    married:[[0,.014,0],[19200,.032,269],[28800,.055,576],[38400,.064,1104],[48000,.068,1718],
      [72000,.072,3350],[96000,.076,5078],[250000,.079,16782]]
  };
  const kansasTables = {
    52:[[69,512,23],[158,1043,46]],
    26:[[139,1023,46],[317,2086,92]],
    24:[[150,1109,49.83],[343,2260,99.67]],
    12:[[300,2217,99.67],[687,4520,199.33]]
  };
  const kansasAllowance = {52:44.62,26:89.23,24:96.67,12:193.33};
  const kansasStandard = {52:[176.15,352.31],26:[352.31,704.62],24:[381.67,763.33],12:[763.33,1526.67]};

  const montanaTables = {
    single:{52:[310,1223,43],26:[619,2446,86],24:[671,2650,94],12:[1342,5300,187]},
    married:{52:[619,2446,86],26:[1238,4892,172],24:[1342,5300,187],12:[2683,10600,372]},
    head:{52:[464,1835,65],26:[929,3669,129],24:[1006,3975,140],12:[2013,7950,280]}
  };
  const westVirginiaRates = [.0211,.0281,.0316,.0422,.0458];
  const westVirginiaTables = {
    one:{
      52:[[0,192,481,769,1154],[0,4.05,12.17,21.27,37.52]],
      26:[[0,385,962,1538,2308],[0,8.12,24.34,42.54,75.03]],
      24:[[0,417,1042,1667,2500],[0,8.80,26.36,46.11,81.26]],
      12:[[0,833,2083,3333,5000],[0,17.58,52.70,92.20,162.55]]
    },
    two:{
      52:[[0,144,361,577,866],[0,3.04,9.13,15.95,28.14]],
      26:[[0,289,722,1154,1731],[0,6.09,18.25,31.90,56.27]],
      24:[[0,313,782,1250,1875],[0,6.60,19.77,34.58,60.95]],
      12:[[0,625,1562,2500,3750],[0,13.18,39.53,69.15,121.91]]
    }
  };

  const californiaRates = [.011,.022,.044,.066,.088,.1023,.1133,.1243,.1353,.1463];
  const californiaAllowances = {
    52:{ low:[363,727], standard:[110,219], credit:[0,3.24,6.47,9.71,12.95,16.18,19.42,22.66,25.89,29.13,32.37] },
    26:{ low:[727,1454], standard:[219,439], credit:[0,6.47,12.95,19.42,25.89,32.37,38.84,45.31,51.78,58.26,64.73] },
    24:{ low:[787,1575], standard:[238,476], credit:[0,7.01,14.03,21.04,28.05,35.06,42.08,49.09,56.10,63.11,70.13] },
    12:{ low:[1575,3149], standard:[476,951], credit:[0,14.03,28.05,42.08,56.10,70.13,84.15,98.18,112.20,126.23,140.25] }
  };

  function california({ wages, periods, elections }) {
    const { caStatus:status, caRegular:regular, caDeduction:deduction } = elections;
    const { low,standard,credit } = californiaAllowances[periods];
    const marriedDeduction = status === 'married' && regular + deduction >= 2;
    const group = Number(status === 'head' || marriedDeduction);
    if (wages <= low[group]) return 0;
    const amount = wages - standard[group] -
      (deduction > 10 ? deduction * Math.round(1000 / periods) : Math.round(deduction * 1000 / periods));
    const brackets = californiaTables[periods][status];
    const index = brackets.findLastIndex(([floor]) => amount >= floor);
    if (index < 0) return 0;
    const [floor,base] = brackets[index];
    return Math.max(0,cents((amount - floor) * californiaRates[index] + base) -
      (regular <= 10 ? credit[regular] : regular * credit[1]));
  }

  function stepsAbove(amount, threshold, step, maximum) {
    return Math.min(maximum,Math.max(0,Math.ceil((amount - threshold) / step)));
  }

  const connecticutBase = {
    A:[[0,.02,0],[10000,.045,200],[50000,.055,2000],[100000,.06,4750],[200000,.065,10750],
      [250000,.069,14000],[500000,.0699,31250]],
    B:[[0,.02,0],[16000,.045,320],[80000,.055,3200],[160000,.06,7600],[320000,.065,17200],
      [400000,.069,22400],[800000,.0699,50000]],
    C:[[0,.02,0],[20000,.045,400],[100000,.055,4000],[200000,.06,9500],[400000,.065,21500],
      [500000,.069,28000],[1000000,.0699,62500]]
  };
  const connecticutExemptions = { A:[12000,24000], B:[19000,38000], C:[24000,48000], F:[15000,30000] };
  const connecticutAddBack = { A:[50250,2500,25], B:[78500,4000,40], C:[100500,5000,50], F:[56500,5000,25] };
  const connecticutRecapture = {
    A:[5000,105000,25,200000,90,500000,50],
    B:[8000,168000,40,320000,140,800000,80],
    C:[10000,210000,50,400000,180,1000000,100]
  };
  const connecticutCreditRates = [.75,.70,.65,.60,.55,.50,.45,.40,.35,.30,.25,.20,.15,.14,.13,.12,.11,
    .10,.09,.08,.07,.06,.05,.04,.03,.02,.01];
  const connecticutCreditLimits = {
    A:[15000,15500,16000,16500,17000,17500,18000,18500,20000,20500,21000,21500,25000,25500,26000,
      26500,27000,48000,48500,49000,49500,50000,50500,51000,51500,52000,52500],
    B:[24000,24500,25000,25500,26000,26500,27000,27500,34000,34500,35000,35500,44000,44500,45000,
      45500,46000,74000,74500,75000,75500,76000,76500,77000,77500,78000,78500],
    C:[30000,30500,31000,31500,32000,32500,33000,33500,40000,40500,41000,41500,50000,50500,51000,
      51500,52000,96000,96500,97000,97500,98000,98500,99000,99500,100000,100500],
    F:[18800,19300,19800,20300,20800,21300,21800,22300,25000,25500,26000,26500,31300,31800,32300,
      32800,33300,60000,60500,61000,61500,62000,62500,63000,63500,64000,64500]
  };

  function connecticut({ wages, periods, elections }) {
    const code = elections.ctCode;
    const baseCode = ['B','C'].includes(code) ? code : 'A';
    const annual = wages * periods;
    const [exemption,exemptionLimit] = connecticutExemptions[code] || [0,0];
    const taxable = annual - exemption + 1000 * stepsAbove(annual,exemptionLimit,1000,exemption / 1000);
    if (taxable <= 0) return 0;
    const [addThreshold,addStep,addAmount] = connecticutAddBack[code === 'D' ? 'A' : code];
    const [step,firstThreshold,firstAmount,secondThreshold,secondAmount,thirdThreshold,thirdAmount] =
      connecticutRecapture[baseCode];
    const recapture = stepsAbove(annual,firstThreshold,step,10) * firstAmount +
      stepsAbove(annual,secondThreshold,step,30) * secondAmount + stepsAbove(annual,thirdThreshold,step,8) * thirdAmount;
    const creditIndex = (connecticutCreditLimits[code] || []).findIndex(limit => annual <= limit);
    const annualTax = bracketTax(taxable,connecticutBase[baseCode]) + recapture +
      stepsAbove(annual,addThreshold,addStep,10) * addAmount;
    return annualTax * (1 - (connecticutCreditRates[creditIndex] || 0)) / periods;
  }

  const northDakotaCurrent = {
    single:[57625,258450,3916.09], married:[57500,168525,2164.99], head:[78475,289675,4118.40]
  };
  const northDakotaLegacy = {
    52:[[1108,4970,75.31],[1106,3241,41.63]],
    26:[[2216,9940,150.62],[2212,6482,83.27]],
    24:[[2401,10769,163.18],[2396,7022,90.21]],
    12:[[4802,21538,326.35],[4792,14044,180.41]]
  };

  function northDakota({ wages, periods, elections }) {
    const status = elections.ndStatus;
    if (status.startsWith('old')) {
      const allowance = {52:97,26:194,24:210,12:420}[periods];
      const [lower,upper,base] = northDakotaLegacy[periods][Number(status === 'oldMarried')];
      const amount = wages - elections.ndAllowances * allowance;
      return Math.round(bracketTax(amount,[[lower,.0195,0],[upper,.025,base]]));
    }
    const [lower,upper,base] = northDakotaCurrent[status];
    const amount = bracketTax(wages * periods,[[lower,.0195,0],[upper,.025,base]]);
    return Math.round(amount / periods);
  }

  function oregon({ wages, periods, elections, federalAmount }) {
    if (elections.orStatus === 'noCertificate') return wages * .08;
    if (!Number.isFinite(federalAmount)) return null;
    const married = elections.orStatus === 'married';
    const jointTable = married || elections.orAllowances >= 3;
    const annual = wages * periods;
    const phaseOut = married ? 250000 : 125000;
    const cut = annual < phaseOut ? 0 : Math.min(5,1 + Math.floor((annual - phaseOut) / (married ? 10000 : 5000)));
    const federalCap = 8750 - 1750 * cut;
    const taxable = Math.max(0,annual - (jointTable ? 5820 : 2910) - Math.min(federalAmount * periods,federalCap));
    const allowances = annual > (married ? 200000 : 100000) ? 0 : elections.orAllowances;
    let brackets;
    if (annual < 50000) {
      brackets = jointTable ? [[0,.0475,263],[9100,.0675,695],[22800,.0875,1620]]
        : [[0,.0475,263],[4550,.0675,479],[11400,.0875,941]];
    } else {
      brackets = jointTable ? [[22800,.0875,1357],[250000,.099,21237]] : [[11400,.0875,678],[125000,.099,10618]];
    }
    return Math.round(Math.max(0,bracketTax(taxable,brackets) - allowances * 263) / periods);
  }

  const districtBrackets = [[0,.04,0],[10000,.06,400],[40000,.065,2200],[60000,.085,3500],[250000,.0925,19650],
    [500000,.0975,42775],[1000000,.1075,91525]];
  const delawareBrackets = [[2000,.022,0],[5000,.039,66],[10000,.048,261],[20000,.052,741],[25000,.0555,1001],
    [60000,.066,2943.50]];
  const newJerseyAllowance = {52:19.20,26:38.40,24:41.60,12:83.30};

  function arkansas({ wages, periods, elections }) {
    if (elections.arMethod === 'lowIncome') {
      const { arLowStatus, arLowDependents } = elections;
      if (arLowDependents > 6) return null;
      const split = arLowStatus !== 'single';
      const high = split && arLowDependents >= 2;
      const group = split ? arLowStatus + (high ? 'High' : 'Low') : arLowStatus;
      const row = arkansasLowTables[group][periods].find(([upper]) => Math.round(wages * 100) <= upper);
      return row ? row[1 + arLowDependents - (high ? 2 : 0)] / 100 : null;
    }
    const net = Math.max(0,wages * periods - 2470);
    const midpoint = net < 100001 ? 100 * Math.floor(net / 100) + 50 : net;
    let annual;
    if (midpoint >= 26400) {
      const adjustment = midpoint < 94701 ? 367.16 : Math.max(79.90,369.90 - 10 * Math.floor((midpoint - 94701) / 100));
      annual = midpoint * .037 - adjustment;
    } else if (midpoint >= 16000) annual = midpoint * .034 - 287.97;
    else if (midpoint >= 11200) annual = midpoint * .03 - 223.97;
    else if (midpoint >= 5600) annual = midpoint * .02 - 111.98;
    else annual = 0;
    return Math.max(0,Math.round(annual) - 29 * elections.arExemptions) / periods;
  }

  const ohioTables = {
    52:[[0,500.96,1923.08],[0,8.02,50.54]], 26:[[0,1001.92,3846.15],[0,16.03,101.07]],
    24:[[0,1085.42,4166.67],[0,17.37,109.50]], 12:[[0,2170.83,8333.33],[0,34.73,218.99]]
  };
  const ohioEarlierAmounts = {52:[0,8.89,51.41],26:[0,17.78,102.82],24:[0,19.27,111.40],12:[0,38.53,222.79]};

  const vermontBrackets = {
    single:[[3925,.0335,0],[54675,.066,1700.13],[126775,.076,6458.73],[260225,.0875,16600.93]],
    married:[[11775,.0335,0],[96475,.066,2837.45],[216525,.076,10760.75],[323825,.0875,18915.55]]
  };

  // Maryland counties and Baltimore City, Comptroller's 2026 local withholding rates.
  const marylandLocalities = {
    'md:01':['Allegany County',.032], 'md:02':['Anne Arundel County',null], 'md:03':['Baltimore County',.032],
    'md:04':['Baltimore City',.032], 'md:05':['Calvert County',.032], 'md:06':['Caroline County',.032],
    'md:07':['Carroll County',.0303], 'md:08':['Cecil County',.0274], 'md:09':['Charles County',.0303],
    'md:10':['Dorchester County',.033], 'md:11':['Frederick County',null], 'md:12':['Garrett County',.0265],
    'md:13':['Harford County',.0306], 'md:14':['Howard County',.032], 'md:15':['Kent County',.033],
    'md:16':['Montgomery County',.032], 'md:17':['Prince George’s County',.032], 'md:18':['Queen Anne’s County',.032],
    'md:19':['St. Mary’s County',.032], 'md:20':['Somerset County',.032], 'md:21':['Talbot County',.024],
    'md:22':['Washington County',.0295], 'md:23':['Wicomico County',.032], 'md:24':['Worcester County',.0225],
    'md:nonresident':['Maryland special nonresident tax',.0225]
  };
  // The employer method starts at 4.75%, including the core of the Comptroller's combined withholding tables.
  const marylandBrackets = {
    single:[[0,.0475,0],[100000,.05,4750],[125000,.0525,6000],[150000,.055,7312.50],
      [250000,.0575,12812.50],[500000,.0625,27187.50],[1000000,.065,58437.50]],
    married:[[0,.0475,0],[150000,.05,7125],[175000,.0525,8375],[225000,.055,11000],
      [300000,.0575,15125],[600000,.0625,32375],[1200000,.065,69875]]
  };
  const marylandPeriods = {52:[65.38,61.54,96],26:[130.76,123.08,192],24:[141.66,133.33,208],12:[283.33,266.67,417]};

  function marylandTaxable(wages,periods,exemptions) {
    const [standard,perExemption,minimum] = marylandPeriods[periods];
    return wages < minimum ? 0 : Math.max(0,wages - standard - perExemption * exemptions) * periods;
  }

  function marylandLocality(code,wages,periods,elections) {
    if (!Object.hasOwn(marylandLocalities,code) || !hasElections('MD',elections)) return null;
    const taxable = marylandTaxable(wages,periods,elections.mdExemptions);
    const married = elections.mdStatus === 'married';
    const rate = marylandLocalities[code][1];
    if (rate !== null) return cents(taxable * rate / periods);
    if (code === 'md:02') {
      const brackets = married ? [[0,.027,0],[75000,.0294,2025],[480000,.032,13932]]
        : [[0,.027,0],[50000,.0294,1350],[400000,.032,11640]];
      return cents(bracketTax(taxable,brackets) / periods);
    }
    const frederickRate = taxable <= 25000 ? .0225 : taxable <= (married ? 100000 : 50000) ? .0275
      : taxable <= (married ? 250000 : 150000) ? .0296 : .032;
    return cents(taxable * frederickRate / periods);
  }

  const formulas = {
    AL:alabama,
    AR:arkansas,
    LA:({ wages, periods, elections }) => Math.max(0,wages - 12875 * elections.laDeduction / periods) * .0309,
    MD:({ wages, periods, elections }) => bracketTax(marylandTaxable(wages,periods,elections.mdExemptions),
      marylandBrackets[elections.mdStatus]) / periods,
    NM:({ wages, periods, elections }) => bracketTax(wages,newMexicoTables[periods][elections.nmStatus]),
    OH:({ date, wages, periods, elections }) => {
      const taxable = wages - elections.ohExemptions * cents(650 / periods);
      if (date < '2026-08-01') return periodBrackets(taxable,[.01775,.0299,.0364],
        [ohioTables[periods][0],ohioEarlierAmounts[periods]]);
      return periodBrackets(taxable,[.016,.0299,.034],ohioTables[periods]);
    },
    VT:({ wages, periods, elections, input }) => {
      const taxable = wages * periods - elections.vtAllowances * 5400;
      const extraFederal = elections.vtFederalExtra ? input.federalExtra || 0 : 0;
      return bracketTax(taxable,vermontBrackets[elections.vtStatus]) / periods + extraFederal * .30;
    },
    CA:california,
    CT:connecticut,
    DC:({ wages, periods, elections }) => bracketTax(wages * periods - 4300 * elections.dcAllowances,districtBrackets) / periods,
    DE:({ wages, periods, elections }) => {
      const taxable = wages * periods - (elections.deStatus === 'married' ? 6500 : 3250);
      return Math.max(0,bracketTax(taxable,delawareBrackets) - 110 * elections.deAllowances) / periods;
    },
    ND:northDakota,
    NJ:({ wages, periods, elections }) => bracketTax(wages - elections.njAllowances * newJerseyAllowance[periods],
      newJerseyTables[elections.njRate][periods]),
    OR:oregon,
    HI:({ wages, periods, elections }) => {
      const annual = wages * periods - 1144 * elections.hiAllowances - 4350;
      return bracketTax(annual,hawaiiBrackets[elections.hiStatus]) / periods;
    },
    ID:({ date, wages, periods, elections }) => {
      const earlier = date < '2026-07-31';
      const deduction = (earlier ? 15000 : 16100) * (elections.idStatus === 'married' ? 2 : 1);
      const childAllowance = earlier ? 3868 * elections.idAllowances : 0;
      return Math.round(Math.max(0,wages - (deduction + childAllowance) / periods) * .053);
    },
    KS:({ wages, periods, elections }) => {
      const married = Number(elections.ksStatus === 'married');
      const [lower,upper,base] = kansasTables[periods][married];
      const personal = elections.ksPersonal === 2 ? kansasStandard[periods][1] : kansasStandard[periods][0] * elections.ksPersonal;
      const taxable = wages - personal - kansasAllowance[periods] * elections.ksAllowances;
      return bracketTax(taxable,[[lower,.052,0],[upper,.0558,base]]);
    },
    ME:maine,
    MS:({ wages, periods, elections }) => {
      const deduction = { none:0, single:2300, head:3400, married:4600 }[elections.msStatus];
      const exemption = elections.msStatus === 'none' ? 0 : elections.msExemption;
      return Math.max(0,wages - (10000 + deduction + exemption) / periods) * .04;
    },
    MT:({ wages, periods, elections }) => {
      const [lower,upper,base] = montanaTables[elections.mtStatus][periods];
      const amount = Math.round(bracketTax(wages,[[lower,.047,0],[upper,.0565,base]]));
      return Math.round(amount + wages * elections.mtPercent / 100);
    },
    WV:({ date, wages, periods, elections }) => {
      if (date < '2026-06-12') return null;
      const taxable = wages - elections.wvExemptions * cents(2000 / periods);
      return periodBrackets(taxable,westVirginiaRates,westVirginiaTables[elections.wvStatus][periods]);
    },
    MN:({ wages, periods, elections }) => {
      const annual = wages * periods - 5300 * elections.mnAllowances;
      return bracketTax(annual,minnesotaBrackets[elections.mnStatus]) / periods;
    },
    NE:nebraska,
    OK:({ wages, periods, elections }) => {
      const taxable = wages - elections.okAllowances * annualExemption1000[periods];
      return Math.round(periodBrackets(taxable,oklahomaRates,oklahomaTables[periods][Number(elections.okStatus === 'married')]));
    },
    RI:({ wages, periods, elections }) => {
      const exempt = wages <= rhodeIslandExemptionLimit[periods] ? annualExemption1000[periods] * elections.riExemptions : 0;
      return periodBrackets(wages - exempt,[.0375,.0475,.0599],rhodeIslandTables[periods]);
    },
    SC:({ wages, periods, elections }) => {
      const annual = wages * periods;
      const standard = elections.scAllowances ? Math.min(annual * .10,7500) : 0;
      const taxable = annual - standard - 5000 * elections.scAllowances;
      return bracketTax(taxable,[[3640,.03,0],[18230,.06,437.70]]) / periods;
    },
    WI:({ wages, periods, elections }) => {
      const annual = wages * periods;
      const married = elections.wiStatus === 'married';
      const [maximum, start, reduction] = married ? [9461,25727,.20] : [6702,17780,.12];
      const deduction = Math.max(0,maximum - Math.max(0,annual - start) * reduction);
      const taxable = annual - deduction - 400 * elections.wiExemptions;
      return bracketTax(taxable,[[0,.0354,0],[12760,.0465,451.70],[25520,.053,1045.04],[280950,.0765,14582.83]]) / periods;
    }
  };

  function hasElections(state, elections) {
    return Boolean(elections && (fields[state] || []).every(([key,,choices,format]) => {
      const value = elections[key];
      return choices ? choices.some(([choice]) => choice === value)
        : Number.isFinite(value) && value >= 0 && (format === 'percent' ? value <= 100 : format === 'money' || Number.isInteger(value));
    }));
  }

  function calculate(state, parameters) {
    if (!Object.hasOwn(formulas,state) || !hasElections(state,parameters.elections)) return null;
    const amount = formulas[state](parameters);
    return amount === null ? null : cents(amount);
  }

  return { sources, fields, hasElections, calculate, marylandLocalities, marylandLocality };
})();

if (typeof module !== 'undefined') module.exports = payrollTaxStateFormulas;
