const linkedProfileLabels={company_driver:'Company Driver',driver:'Owner Op',mechanic:'Mechanic'};
let fleetLinkRead=null;
let ownProfileRead=null;
let linkPreview=null;
let ownLinkKey=null;
let ownKeyRequest=null;
const linkKeyFormat=/^(?:[A-Z0-9]{6}|[A-F0-9]{20})$/;
const cleanLinkKey=value=>value.replace(/[\s-]/g,'').toUpperCase();
const linkExpiryFormat=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});

async function callFleetProfiles(action,fields={}){
 const {data,error}=await supabaseClient.functions.invoke('fleet-profile-links',{body:{action,...fields}});
 if(error){
  const response=await error.context?.json?.().catch(()=>null);
  throw new Error(response?.message||'Could not reach fleet profiles. Try again.');
 }
 return data;
}

async function loadFleetProfileLinks(){
 const owner=currentUser;
 const fleetId=adminFleetId;
 if(!owner||!fleetId||fleetSection!=='links')return;
 const request={};
 fleetLinkRead=request;
 const current=()=>currentUser===owner&&adminFleetId===fleetId&&fleetSection==='links'&&fleetLinkRead===request;
 const status=document.getElementById('fleetLinksStatus');
 const body=document.getElementById('fleetLinkRows');
 const table=document.getElementById('fleetLinkTable');
 status.textContent='Loading linked profiles…';
 table.classList.add('hidden');
 try{
  const {links}=await callFleetProfiles('list');
  if(!current())return;
  const rows=links.filter(link=>link.rigtracker_profiles).map(({rigtracker_profiles:profile,employee_number})=>{
   const row=document.createElement('tr');
   const nameCell=row.insertCell();
   const name=[profile.first_name,profile.last_name].filter(Boolean).join(' ')||'—';
   if(['company_driver','driver'].includes(profile.profile_type)){
    const open=document.createElement('button');
    open.type='button';
    open.className='link-btn company-driver-profile-link';
    open.textContent=name;
    open.addEventListener('click',()=>companyDriverTools.openAdmin(profile,'links',null,fleetId));
    nameCell.append(open);
   }else nameCell.textContent=name;
   row.insertCell().textContent=linkedProfileLabels[profile.profile_type];
   row.insertCell().textContent=employee_number||'—';
   const remove=document.createElement('button');
   remove.type='button';
   remove.className='outline';
   remove.textContent='Remove link';
   remove.addEventListener('click',()=>mutateFleetProfile(remove,'unlink',{profileId:profile.profile_id}));
   row.insertCell().append(remove);
   return row;
  });
  body.replaceChildren(...rows);
  status.textContent=rows.length?'':'No profiles are linked yet.';
  table.classList.toggle('hidden',!rows.length);
 }catch(error){
  if(current())status.textContent=error.message;
 }
}

async function mutateFleetProfile(control,action,fields,form){
 const owner=currentUser;
 const fleetId=adminFleetId;
 if(!owner||!fleetId||accountTypeFor(owner)!=='fleet'||control.disabled)return;
 control.disabled=true;
 try{
  const result=await callFleetProfiles(action,fields);
  if(currentUser!==owner||adminFleetId!==fleetId)return;
  form?.reset();
  if(action==='link')clearLinkPreview();
  const messages={
   link:'Profile linked.',
   unlink:'Fleet link removed.',
   create_company_driver:'Company Driver created and linked.'
  };
  showToast(messages[action]);
  if(action==='create_company_driver'&&result.profileId&&fleetSection==='links'&&document.getElementById('fleetWorkspace').classList.contains('active')){
   await companyDriverTools.openAdmin({profile_id:result.profileId,first_name:fields.firstName,last_name:fields.lastName});
   return;
  }
  await loadFleetProfileLinks();
 }catch(error){
  if(currentUser===owner&&adminFleetId===fleetId)showToast(error.message);
 }finally{control.disabled=false}
}

function clearLinkPreview(){
 linkPreview=null;
 const number=document.getElementById('linkEmployeeNumber');
 number.value='';
 number.disabled=true;
 document.getElementById('linkEmployeeNumberField').classList.add('hidden');
 document.getElementById('linkProfileSubmit').textContent='Check Key';
 document.getElementById('linkProfilePreview').textContent='';
}
document.getElementById('linkProfileKey').addEventListener('input',clearLinkPreview);

function resetFleetLinkForm(){
 document.getElementById('linkExistingProfileForm').reset();
 clearLinkPreview();
}

async function saveRigTrackerLink(event){
 event.preventDefault();
 const user=currentUser;
 if(!user||fleetSection!=='links')return;
 const office=accountTypeFor(user)==='employee';
 const allowed=()=>office?officeTools.canLinkProfiles():accountTypeFor(user)==='fleet'&&Boolean(adminFleetId);
 if(!allowed())return;
 const form=event.currentTarget;
 const control=document.getElementById('linkProfileSubmit');
 const field=document.getElementById('linkProfileKey');
 const status=document.getElementById('linkProfilePreview');
 if(control.disabled)return;
 const key=cleanLinkKey(field.value);
 if(!linkKeyFormat.test(key)){
  status.textContent='Enter the complete link key from the profile owner.';
  field.focus();
  return;
 }
 const redeem=linkPreview===key;
 const employeeNumber=document.getElementById('linkEmployeeNumber').value;
 if(redeem&&!office)return mutateFleetProfile(control,'link',{linkKey:key,employeeNumber},form);

 const current=()=>currentUser===user&&fleetSection==='links'&&allowed()&&cleanLinkKey(field.value)===key;
 control.disabled=true;
 status.textContent=redeem?'Linking profile…':'Checking link key…';
 try{
  let profile;
  if(office){
   const {data,error}=await supabaseClient.rpc('profile_link_key',{
    action:redeem?'redeem':'preview',link_key:key,employee_number:redeem&&employeeNumber?employeeNumber:null
   });
   if(error)throw error;
   if(data?.link_key_error)throw new Error(data.link_key_error);
   if(!current())return;
   if(redeem){
    resetFleetLinkForm();
    status.textContent='Profile linked.';
    return;
   }
   profile=data;
  }else{
   ({profile}=await callFleetProfiles('preview_link',{linkKey:key}));
  }
  if(!current())return;
  linkPreview=key;
  const label=linkedProfileLabels[profile.profile_type];
  const name=[profile.first_name,profile.last_name].filter(Boolean).join(' ');
  status.textContent=[name,label].filter(Boolean).join(' · ');
  const companyDriver=profile.profile_type==='company_driver';
  document.getElementById('linkEmployeeNumberField').classList.toggle('hidden',!companyDriver);
  document.getElementById('linkEmployeeNumber').disabled=!companyDriver;
  control.textContent='Link Profile';
 }catch(error){
  if(current())status.textContent=error.message;
 }finally{control.disabled=false}
}

function showOwnLinkKey(expiresAt,message=''){
 if(ownLinkKey?.expiresAt!==expiresAt)ownLinkKey=null;
 const code=ownLinkKey?.code||'';
 document.getElementById('ownLinkKey').value=code;
 document.getElementById('ownLinkKeyField').classList.toggle('hidden',!code);
 document.getElementById('ownLinkKeyCopy').classList.toggle('hidden',!code);
 document.getElementById('ownLinkKeyRevoke').classList.toggle('hidden',!expiresAt);
 document.getElementById('ownLinkKeyGenerate').textContent=expiresAt?'Generate New Key':'Generate Link Key';
 const ends=expiresAt?new Date(expiresAt):null;
 const expiry=ends&&Number.isFinite(ends.valueOf())?'Key expires '+linkExpiryFormat.format(ends)+'.':'';
 document.getElementById('ownLinkKeyStatus').textContent=message||expiry;
}

async function updateOwnLinkKey(action){
 const user=currentUser;
 if(!user||ownKeyRequest)return;
 const request={};
 ownKeyRequest=request;
 const controls=['ownLinkKeyGenerate','ownLinkKeyCopy','ownLinkKeyRevoke'].map(id=>document.getElementById(id));
 for(const control of controls)control.disabled=true;
 try{
  const {data,error}=await supabaseClient.rpc('profile_link_key',{action});
  if(currentUser!==user||ownKeyRequest!==request)return;
  if(error)throw error;
  if(action==='issue')ownLinkKey={code:data.key,expiresAt:data.expires_at};
  showOwnLinkKey(data?.expires_at||null,action==='revoke'?'Link key canceled.':'');
 }catch(error){
  if(currentUser===user&&ownKeyRequest===request){
   document.getElementById('ownLinkKeyStatus').textContent=error.message||'Could not update the link key.';
  }
 }finally{
  if(ownKeyRequest===request){
   ownKeyRequest=null;
   for(const control of controls)control.disabled=false;
  }
 }
}

document.getElementById('ownLinkKeyGenerate').addEventListener('click',()=>void updateOwnLinkKey('issue'));
document.getElementById('ownLinkKeyRevoke').addEventListener('click',()=>void updateOwnLinkKey('revoke'));
document.getElementById('ownLinkKeyCopy').addEventListener('click',async()=>{
 if(!ownLinkKey?.code)return;
 const field=document.getElementById('ownLinkKey');
 try{
  await navigator.clipboard.writeText(ownLinkKey.code);
  showToast('Link key copied.');
 }catch{
  field.focus();
  field.select();
 }
});
document.addEventListener('visibilitychange',()=>{
 if(!document.hidden&&document.getElementById('rigTrackerProfilePage').classList.contains('active')
    &&!document.getElementById('rigTrackerProfileDetails').classList.contains('hidden'))void updateOwnLinkKey('status');
});

function createCompanyDriver(event){
 event.preventDefault();
 const form=event.currentTarget;
 const fields=Object.fromEntries(new FormData(form));
 if(!meetsPasswordRequirements(fields.password)){showToast(passwordRequirements);return}
 return mutateFleetProfile(form.querySelector('button[type="submit"]'),'create_company_driver',fields,form);
}

async function openCompanyDriverCreate(){
 if(accountTypeFor(currentUser)!=='fleet')return;
 await showFleetSection('links');
 const form=document.getElementById('companyDriverForm');
 if(fleetSection==='links'&&!form.closest('.hidden')){
  form.scrollIntoView({block:'start'});
  form.elements.firstName.focus({preventScroll:true});
 }
}

async function openOwnRigTrackerProfile({openLoads=false}={}){
 const user=currentUser;
 const role=accountTypeFor(user);
 if(!user||!['company','driver','mechanic'].includes(role))return;
 const request={};
 ownProfileRead=request;
 const current=()=>currentUser===user&&ownProfileRead===request;
 const title=document.getElementById('rigTrackerProfileTitle');
 const form=document.getElementById('ownRigTrackerProfileForm');
 const status=document.getElementById('rigTrackerProfileStatus');
 const details=document.getElementById('rigTrackerProfileDetails');
 const driver=role==='company';
 document.getElementById('companyDriverExtras')?.classList.toggle('hidden',!driver);
 document.getElementById('ownDriverDocumentsButton')?.classList.toggle('hidden',role!=='driver'&&!driver);
 document.getElementById('ownDriverSettlementsButton')?.classList.toggle('hidden',role!=='driver');
 document.getElementById('ownOwnerEscrowButton')?.classList.add('hidden');
 document.getElementById('companyDriverPayButton')?.classList.toggle('hidden',!driver);
 document.getElementById('ownDriverTaxButton')?.classList.toggle('hidden',role!=='driver'&&!driver);
 document.getElementById('mechanicMessagesButton')?.classList.toggle('hidden',role!=='mechanic');
 document.getElementById('profileDriverLoadsButton')?.classList.toggle('hidden',role!=='driver'&&!driver);
 title.textContent=driver?'Company Driver Dashboard':role==='mechanic'?'Mechanic Dashboard':'RigTracker Profile';
 document.getElementById('rigTrackerProfileBack').classList.toggle('hidden',role!=='driver');
 form.reset();
 details.classList.add('hidden');
 status.classList.remove('hidden');
 status.textContent='Loading your profile…';
 showPage('rigTrackerProfilePage');
 const {data:profile,error}=await supabaseClient.from('rigtracker_profiles')
  .select('display_profile_id,first_name,last_name,phone,license_number,password_required,profile_type').eq('user_id',user.id).maybeSingle();
 if(!current())return;
 if(error||!profile){
  status.textContent='Could not load your profile. Try signing in again.';
  return;
 }
 if(profile.password_required){
  openRigTrackerPasswordChange(true);
  return;
 }
 status.classList.add('hidden');
 details.classList.remove('hidden');
 document.getElementById('ownOwnerEscrowButton')?.classList.toggle('hidden',role!=='driver'||profile.profile_type!=='driver');
 if(driver&&typeof rigTrackerApp!=='undefined')rigTrackerApp.companyReady();
 if(driver&&typeof companyDriverTools!=='undefined')companyDriverTools.refresh();
 if((driver||role==='mechanic')&&typeof companyMessaging!=='undefined')void companyMessaging.refresh();
 const hasDriverWorkflow=(driver||role==='driver')&&typeof driverLoadWorkflow!=='undefined';
 if(hasDriverWorkflow&&!openLoads)void driverLoadWorkflow.refresh(true);
 paintOwnProfileId(profile.display_profile_id);
 const linkAccess={
  company:'Linked fleets can assign loads and share team messages and settlements with you.',
  driver:'Linked fleets can assign loads to you.',
  mechanic:'Linking gives you access to the fleet’s Dispatch, Maintenance, and Safety conversations.'
 };
 document.getElementById('ownLinkAccess').textContent=linkAccess[role];
 void updateOwnLinkKey('status');
 document.getElementById('ownProfileEmail').value=user.email||'';
 for(const key of ['first_name','last_name','phone','license_number']){
  const field=form.elements.namedItem(key);
  field.value=profile[key];
  field.required=driver;
 }
 form.elements.namedItem('license_number').disabled=!driver;
 document.getElementById('ownProfileLicenseField').classList.toggle('hidden',!driver);
 const linkedStatus=document.getElementById('ownRigTrackerLinksStatus');
 const linkedFleets=document.getElementById('ownRigTrackerLinks');
 linkedFleets.replaceChildren();
 linkedStatus.textContent='Loading linked fleets…';
 const {data:links,error:linkError}=await supabaseClient.from('rigtracker_fleet_links')
  .select('fleet_id,employee_number').eq('profile_user_id',user.id).is('unlinked_at',null).order('fleet_id');
 if(!current())return;
 if(linkError){linkedStatus.textContent='Could not load linked fleets.';return}
 linkedStatus.textContent=links.length?'':driver
  ?'Generate a link key above and share it with your fleet office to get linked.'
  :'No fleets are linked.';
 for(const link of links){
  const row=document.createElement('li');
  row.textContent=link.employee_number?link.fleet_id+' · Employee '+link.employee_number:link.fleet_id;
  linkedFleets.append(row);
 }
 if(hasDriverWorkflow&&openLoads&&links.length&&document.getElementById('rigTrackerProfilePage').classList.contains('active')){
  void driverLoadWorkflow.open();
 }
}

function paintOwnProfileId(profileId){
 document.getElementById('ownRigTrackerId').value=profileId||'';
 document.getElementById('ownProfileIdHelp').classList.toggle('hidden',Boolean(profileId));
}

async function saveOwnRigTrackerProfile(event){
 event.preventDefault();
 const user=currentUser;
 const form=event.currentTarget;
 const button=form.querySelector('button[type="submit"]');
 if(!user||button.disabled)return;
 const fields=Object.fromEntries(Array.from(new FormData(form),([key,value])=>[key,value.trim()]));
 if(accountTypeFor(user)==='company'&&Object.values(fields).some(value=>!value)){
  showToast('Complete all company driver fields.');
  return;
 }
 button.disabled=true;
 try{
  const {data,error}=await supabaseClient.from('rigtracker_profiles').update(fields)
   .eq('user_id',user.id).select('display_profile_id').single();
  if(currentUser===user){
   if(!error)paintOwnProfileId(data.display_profile_id);
   showToast(error?'Could not save your profile. Try again.':'Profile saved.');
  }
 }finally{button.disabled=false}
}

function openRigTrackerPasswordChange(useTemporaryPassword){
 const form=document.getElementById('rigTrackerPasswordForm');
 const input=form.elements.namedItem('currentPassword');
 form.reset();
 input.disabled=!useTemporaryPassword;
 input.required=useTemporaryPassword;
 document.getElementById('rigTrackerCurrentPasswordField').classList.toggle('hidden',!useTemporaryPassword);
 showPage('rigTrackerPasswordPage');
}

async function saveRigTrackerPassword(event){
 event.preventDefault();
 const user=currentUser;
 const form=event.currentTarget;
 const button=form.querySelector('button[type="submit"]');
 if(!user||button.disabled)return;
 const values=new FormData(form);
 const password=values.get('password');
 const currentPassword=values.get('currentPassword');
 if(password!==values.get('confirmPassword')){showToast('The new passwords do not match.');return}
 if(password===currentPassword){showToast('Choose a password different from the temporary password.');return}
 if(!meetsPasswordRequirements(password)){
  showToast(passwordRequirements);
  return;
 }
 button.disabled=true;
 try{
  const update=currentPassword?{password,current_password:currentPassword}:{password};
  const {error}=await supabaseClient.auth.updateUser(update);
  if(currentUser!==user)return;
  if(error){showToast(error.message||'Could not save the new password.');return}
  passwordRecoveryRequested=false;
  form.reset();
  await signOut();
  if(!currentUser)showToast('Password saved. Sign in with your new password.');
 }finally{button.disabled=false}
}

async function sendCompanyEmailConfirmation(button){
 const email=document.getElementById('email');
 if(!email.value||!email.reportValidity()){email.focus();return}
 if(!supabaseClient||button.disabled)return;
 button.disabled=true;
 try{
  const {error}=await supabaseClient.auth.resend({
   type:'signup',email:email.value.trim(),options:{emailRedirectTo:window.location.origin}
  });
  showToast(error?error.message:'Check your email for a confirmation link.');
 }finally{button.disabled=false}
}

function resetLinkedProfileScreens(){
 fleetLinkRead=null;
 ownProfileRead=null;
 ownKeyRequest=null;
 ownLinkKey=null;
 passwordRecoveryRequested=false;
 for(const id of ['linkExistingProfileForm','companyDriverForm','ownRigTrackerProfileForm','rigTrackerPasswordForm']){
  document.getElementById(id).reset();
 }
 for(const id of ['fleetLinkRows','ownRigTrackerLinks'])document.getElementById(id).replaceChildren();
 clearLinkPreview();
 showOwnLinkKey(null);
 for(const id of ['ownLinkKeyGenerate','ownLinkKeyCopy','ownLinkKeyRevoke'])document.getElementById(id).disabled=false;
 document.getElementById('ownRigTrackerId').value='';
 document.getElementById('ownProfileEmail').value='';
 document.getElementById('rigTrackerProfileDetails').classList.add('hidden');
}
