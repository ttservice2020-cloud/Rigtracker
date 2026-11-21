const linkedProfileLabels={company_driver:'Company Driver',driver:'Owner Op',mechanic:'Mechanic'};
let fleetLinkRead=null;
let ownProfileRead=null;

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
   row.insertCell().textContent=[profile.first_name,profile.last_name].filter(Boolean).join(' ')||'—';
   row.insertCell().textContent=linkedProfileLabels[profile.profile_type];
   row.insertCell().textContent=profile.profile_id;
   row.insertCell().textContent=employee_number||'—';
   const remove=document.createElement('button');
   remove.type='button';
   remove.className='outline';
   remove.textContent='Remove link';
   remove.addEventListener('click',()=>mutateFleetProfile(remove,'unlink',{profileId:profile.profile_id}));
   const actions=row.insertCell();
   if(profile.profile_type==='company_driver'&&typeof companyDriverTools!=='undefined'){
    const manage=document.createElement('button');
    manage.type='button';
    manage.className='outline';
    manage.textContent='Manage Driver';
    manage.addEventListener('click',()=>companyDriverTools.openAdmin(profile));
    actions.append(manage);
   }
   actions.append(remove);
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
  const messages={
   link:'Profile linked.',
   unlink:'Fleet link removed.',
   create_company_driver:result.profileId?'Company Driver created. RigTracker ID: '+result.profileId:'Company Driver created.'
  };
  showToast(messages[action]);
  await loadFleetProfileLinks();
 }catch(error){
  if(currentUser===owner&&adminFleetId===fleetId)showToast(error.message);
 }finally{control.disabled=false}
}

function saveRigTrackerLink(event){
 event.preventDefault();
 const form=event.currentTarget;
 return mutateFleetProfile(form.querySelector('button[type="submit"]'),'link',Object.fromEntries(new FormData(form)),form);
}

function createCompanyDriver(event){
 event.preventDefault();
 const form=event.currentTarget;
 return mutateFleetProfile(form.querySelector('button[type="submit"]'),'create_company_driver',Object.fromEntries(new FormData(form)),form);
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
  .select('profile_id,first_name,last_name,phone,license_number,password_required').eq('user_id',user.id).maybeSingle();
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
 if(driver&&typeof rigTrackerApp!=='undefined')rigTrackerApp.companyReady();
 if(driver&&typeof companyDriverTools!=='undefined')companyDriverTools.refresh();
 if((driver||role==='mechanic')&&typeof companyMessaging!=='undefined')void companyMessaging.refresh();
 if((driver||role==='driver')&&typeof driverLoadWorkflow!=='undefined'){
  if(openLoads&&document.getElementById('rigTrackerProfilePage').classList.contains('active'))void driverLoadWorkflow.open();
  else void driverLoadWorkflow.refresh(true);
 }
 document.getElementById('ownRigTrackerId').value=profile.profile_id;
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
 linkedStatus.textContent=links.length?'':'No fleets are linked.';
 for(const link of links){
  const row=document.createElement('li');
  row.textContent=link.employee_number?link.fleet_id+' · Employee '+link.employee_number:link.fleet_id;
  linkedFleets.append(row);
 }
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
  const {error}=await supabaseClient.from('rigtracker_profiles').update(fields)
   .eq('user_id',user.id).select('profile_id').single();
  if(currentUser===user)showToast(error?'Could not save your profile. Try again.':'Profile saved.');
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
 if(password.length<8||new TextEncoder().encode(password).length>72){
  showToast('Use at least 8 characters and at most 72 bytes.');
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
 passwordRecoveryRequested=false;
 for(const id of ['linkExistingProfileForm','companyDriverForm','ownRigTrackerProfileForm','rigTrackerPasswordForm']){
  document.getElementById(id).reset();
 }
 for(const id of ['fleetLinkRows','ownRigTrackerLinks'])document.getElementById(id).replaceChildren();
 document.getElementById('ownRigTrackerId').value='';
 document.getElementById('ownProfileEmail').value='';
 document.getElementById('rigTrackerProfileDetails').classList.add('hidden');
}
