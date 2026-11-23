const payrollTaxDeductions = (() => {
  'use strict';

  const sources = {
    federalUnemployment:'https://www.irs.gov/publications/p15',
    stateUnemployment:'https://oui.doleta.gov/unemploy/statelaws.asp',
    garnishment:'https://www.dol.gov/agencies/whd/fact-sheets/30-cppa/'
  };
  // State UI wage bases for 2026. MI, NE, and RI have different bases by account.
  // Nevada DETR identifies $45,400 as the 2027 base. The 2026 base is $43,700.
  const stateWageBases = {
    AK:54200, AL:8000, AR:7000, AZ:8000, CA:7000, CO:30600, CT:27000,
    DC:9000, DE:14500, FL:7000, GA:9500, HI:64500, IA:20400, ID:58300,
    IL:14250, IN:9500, KS:15100, KY:12000, LA:7000, MA:15000, MD:8500, ME:12000,
    MI:[9000,9500], MN:44000, MO:9000, MS:14000, MT:47300, NC:34200, ND:46600,
    NE:[9000,24000], NH:14000, NJ:44800, NM:34800, NV:43700, NY:17600, OH:9000,
    OK:25000, OR:56700, PA:10000, RI:[30800,32300], SC:14000, SD:15000,
    TN:7000, TX:9000, UT:50700, VA:8000, VT:15400, WA:78200, WI:14000, WV:9500, WY:33800
  };
  const wageFields = ['federalWages','stateWages','localWages','socialSecurityWages','medicareWages','futaWages','sutaWages'];
  const supplementalTypes = new Set(['bonus','commission','overtime','taxableReimbursement','otherSupplemental']);

  function isSupplemental(type) {
    return supplementalTypes.has(type);
  }

  function payAmounts(regularPay,payItems,deductions) {
    const cents = amount => Math.round(amount * 100);
    let gross = cents(regularPay);
    let taxable = gross;
    let supplemental = 0;
    for (const {type,amount} of payItems) {
      const item = cents(amount);
      gross += item;
      if (type !== 'accountableReimbursement') taxable += item;
      if (isSupplemental(type)) supplemental += item;
    }
    const wageBases = Object.fromEntries(wageFields.map(key => [key,taxable]));
    for (const {amount,reduces} of deductions) {
      for (const key of reduces) wageBases[key] -= cents(amount);
    }
    if (Object.values(wageBases).some(amount => amount < 0)) {
      throw new Error('Pre-tax deductions exceed the eligible wages for this check.');
    }
    for (const key of wageFields) wageBases[key] /= 100;
    return {grossPay:gross / 100,taxableGross:taxable / 100,supplementalGross:supplemental / 100,wageBases};
  }

  function stateWageBase(state,year) {
    return year === 2026 ? stateWageBases[state] : undefined;
  }

  function unemployment(wages,ytd,wageBase,rate) {
    if (![wages,ytd,wageBase,rate].every(value => Number.isFinite(value) && value >= 0) || rate > 100) {
      throw new Error('Enter the unemployment wage base, covered wages, year-to-date wages, and the verified rate.');
    }
    const taxable = Math.min(wages,Math.max(0,wageBase - ytd));
    return Math.round(taxable * rate + 0.0000001) / 100;
  }

  function federalGarnishmentLimit(periods,disposable,category,supportsOther,past12Weeks) {
    const minimumRetained = {52:217.50,26:435,24:471.25,12:942.50}[periods];
    if (!Number.isFinite(minimumRetained) || !Number.isFinite(disposable) || disposable < 0) {
      throw new Error('Enter the disposable earnings for this pay period to check the garnishment limit.');
    }
    const limit = category === 'support'
      ? disposable * ((supportsOther ? 50 : 60) + (past12Weeks ? 5 : 0)) / 100
      : Math.min(disposable * .25,Math.max(0,disposable - minimumRetained));
    return Math.floor(limit * 100 + 0.0000001) / 100;
  }

  return { sources, stateWageBase, unemployment, federalGarnishmentLimit, isSupplemental, payAmounts };
})();

if (typeof module !== 'undefined') module.exports = payrollTaxDeductions;
