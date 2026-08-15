  'use strict';
  const T=Object.freeze({loading:'Loading…',empty:'No records found.',notConfigured:'Not configured',signedIn:'Signed in.',signedOut:'Signed out.',saved:'Changes saved.',created:'Created successfully.',rotated:'Token rotated. The previous token is now invalid.',authFailed:'Authentication failed. The admin key was cleared.',requestFailed:'Request failed.',confirmRotate:'Rotate this user token? The previous token will stop working immediately.',confirmDeleteModel:'Delete this model permanently?',confirmDeleteProvider:'Delete this provider permanently?',promptInput:'Daily input quota (0 = unlimited)',promptOutput:'Daily output quota (0 = unlimited)',promptModels:'Allowed model identifiers separated by commas. Leave blank for all models.',promptIdentifier:'Identifier',promptDisplay:'Display name',promptMax:'Maximum output tokens',promptInputPrice:'Input USD per 1 million tokens. Leave blank if not configured.',promptOutputPrice:'Output USD per 1 million tokens. Leave blank if not configured.',promptProvider:'Provider numeric ID',promptUrl:'Base URL',promptAuth:'Authentication type: none, api_key, or bearer_token',promptCredential:'New stored credential. Leave blank to keep the current credential.'});
  const state={key:'',users:[],models:[],providers:[],filters:[],builtInPii:null,presets:[]};
  const SECTION_LABELS=Object.freeze({
    overview:'Overview',
    users:'Users',
    models:'Models',
    providers:'Providers',
    filters:'Filters',
    stats:'Usage',
  });
  const el=(id)=>document.getElementById(id);
  const actionButtons=new Map();
  let activeDialogTrigger=null;
  let restoreDialogFocusOnClose=true;
  let pendingConfirmation=null;
  let pendingUserOperation=null;
  let pendingConfirmationOperation=null;
  let pendingModelOperation=null;
  let pendingProviderOperation=null;
  let pendingDiscoveryRequest=null;
  let discovery=null;
  function showStatus(message,kind){const box=el('status');box.textContent=message;box.className=`status ${kind||''}`.trim()}
  function clearStatus(){el('status').className='status hidden'}
  function node(tag,text,className){const item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);if(className)item.className=className;return item}
  function formatDate(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.valueOf())?'—':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date)}
  function number(value){return new Intl.NumberFormat().format(value||0)}
  function quota(value){return value===0?'Unlimited':number(value)}
  function money(value,configured){return configured?new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:6}).format(value||0):T.notConfigured}
  async function api(path,options={}){const headers={'X-Admin-Key':state.key,...(options.headers||{})};if(options.body)headers['Content-Type']='application/json';const response=await fetch(path,{...options,headers});let body=null;try{body=await response.json()}catch{}if(!response.ok){if(response.status===401||response.status===403){state.key='';showLogin();showStatus(T.authFailed,'error')}const error=new Error(body&&body.error?body.error:T.requestFailed);error.status=response.status;throw error}return body}
  function showLogin(){el('login').classList.remove('hidden');el('dashboard').classList.add('hidden');el('admin-key').value=''}
  function selectSection(name){document.querySelectorAll('nav [data-tab]').forEach((item)=>{if(item.dataset.tab===name)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current')});Object.keys(SECTION_LABELS).forEach((sectionName)=>el('tab-'+sectionName).classList.toggle('hidden',sectionName!==name));el('section-title').textContent=SECTION_LABELS[name]}
  function showDashboard(){el('login').classList.add('hidden');el('dashboard').classList.remove('hidden');selectSection('overview')}
  function button(text,handler,className){const item=node('button',text,className);item.type='button';item.addEventListener('click',handler);return item}
  function actionButton(key,text,handler,className){const item=button(text,handler,className);actionButtons.set(key,item);return item}
  function triggerReference(item,key=null,fallback=null){return{key,node:item,fallback}}
  function focusTrigger(reference){const target=reference&&reference.key&&actionButtons.get(reference.key)||reference&&reference.fallback||reference&&reference.node;if(target)target.focus()}
  function showDialogStatus(id,message,kind='error'){const box=el(id);box.textContent=message;box.className=`status ${kind}`}
  function clearDialogStatus(id){const box=el(id);box.textContent='';box.className='status hidden'}
  function setUserPending(pending){el('user-submit').disabled=pending;el('user-cancel').disabled=pending;el('user-token-close').disabled=pending}
  function setModelPending(pending){el('model-submit').disabled=pending;el('model-cancel').disabled=pending}
  function setProviderPending(pending){el('provider-submit').disabled=pending;el('provider-cancel').disabled=pending}
  function setConfirmationPending(pending){el('confirm-submit').disabled=pending;el('confirm-cancel').disabled=pending}
  function nullableNumber(value){return String(value)===''?null:Number(value)}
  function resourceDialogEntryBlocked(){return Boolean(pendingUserOperation||pendingModelOperation||pendingProviderOperation||pendingConfirmationOperation||el('confirm-dialog').open||el('user-dialog').open||el('model-dialog').open||el('provider-dialog').open)}
  function openDialog(dialog,reference,firstControl){activeDialogTrigger=reference;restoreDialogFocusOnClose=true;dialog.showModal();firstControl.focus()}
  function closeDialog(dialog,restoreFocus=true){restoreDialogFocusOnClose=restoreFocus;dialog.close()}
  function handleDialogClose(statusId,cleanup){const reference=activeDialogTrigger,restoreFocus=restoreDialogFocusOnClose;activeDialogTrigger=null;restoreDialogFocusOnClose=true;clearDialogStatus(statusId);cleanup();if(restoreFocus)focusTrigger(reference)}
  async function refreshAfterMutation(reference,fallback,message){try{await loadAll();if(message)showStatus(message,'success')}catch(error){showStatus(error.message,'error')}focusTrigger({key:reference&&reference.key,node:reference&&reference.node,fallback})}
  function openUserCreate(trigger){if(resourceDialogEntryBlocked())return;const form=el('user-form');form.reset();form.elements.userId.value='';form.elements.username.disabled=false;el('user-dialog-title').textContent='Create user';el('user-submit').textContent='Create user';setUserPending(false);el('user-token-value').textContent='';el('user-token-result').classList.add('hidden');form.classList.remove('hidden');clearDialogStatus('user-dialog-status');openDialog(el('user-dialog'),triggerReference(trigger,null,el('create-user')),form.elements.username)}
  function openUserEdit(user){if(resourceDialogEntryBlocked())return;const form=el('user-form'),key=`user:${user.id}:edit`;form.reset();form.elements.userId.value=String(user.id);form.elements.username.value=user.username;form.elements.username.disabled=true;form.elements.inputQuota.value=String(user.max_daily_input_tokens);form.elements.outputQuota.value=String(user.max_daily_output_tokens);form.elements.allowedModels.value=(user.allowed_models||[]).join(', ');el('user-dialog-title').textContent='Edit user';el('user-submit').textContent='Save user';setUserPending(false);el('user-token-value').textContent='';el('user-token-result').classList.add('hidden');form.classList.remove('hidden');clearDialogStatus('user-dialog-status');openDialog(el('user-dialog'),triggerReference(actionButtons.get(key),key,el('create-user')),form.elements.inputQuota)}
  function showUserTokenResult(token,title,reference){const form=el('user-form'),dialog=el('user-dialog'),copy=el('user-token-copy');form.classList.add('hidden');el('user-dialog-title').textContent=title;el('user-token-value').textContent=token;el('user-token-result').classList.remove('hidden');setUserPending(false);clearDialogStatus('user-dialog-status');if(dialog.open)copy.focus();else openDialog(dialog,reference,copy)}
  function openConfirmation({trigger,title,message,submitLabel,action,onSuccess,fallback}){if(pendingConfirmationOperation||el('confirm-dialog').open)return;pendingConfirmation={trigger,action,onSuccess,fallback};el('confirm-title').textContent=title;el('confirm-message').textContent=message;el('confirm-submit').textContent=submitLabel;setConfirmationPending(false);clearDialogStatus('confirm-dialog-status');openDialog(el('confirm-dialog'),trigger,el('confirm-submit'))}
  function resetModelDiscovery(){discovery=null;const form=el('model-form');form.elements.providerId.disabled=false;el('model-discovery-list').replaceChildren();el('model-discovery').classList.add('hidden')}
  function openModelCreate(trigger,key=null){if(resourceDialogEntryBlocked())return false;pendingDiscoveryRequest=null;const form=el('model-form');form.reset();resetModelDiscovery();form.elements.modelId.value='';el('model-dialog-title').textContent='Create model';el('model-submit').textContent='Create model';setModelPending(false);clearDialogStatus('model-dialog-status');openDialog(el('model-dialog'),triggerReference(trigger,key,el('create-model')),form.elements.modelName);return true}
  function modelValue(value){return value===null||value===undefined?'':String(value)}
  function openModelEdit(model){if(resourceDialogEntryBlocked())return;const form=el('model-form'),key=`model:${model.id}:edit`;form.reset();resetModelDiscovery();form.elements.modelId.value=String(model.id);form.elements.modelName.value=model.model_name;form.elements.displayName.value=model.display_name;form.elements.providerId.value=String(model.provider_id);form.elements.maxTokens.value=String(model.max_tokens);form.elements.inputPrice.value=modelValue(model.input_cost_per_million);form.elements.outputPrice.value=modelValue(model.output_cost_per_million);form.elements.contextWindow.value=modelValue(model.context_window);form.elements.defaultTemperature.value=modelValue(model.default_temperature);form.elements.defaultTopP.value=modelValue(model.default_top_p);form.elements.defaultPresencePenalty.value=modelValue(model.default_presence_penalty);form.elements.defaultFrequencyPenalty.value=modelValue(model.default_frequency_penalty);form.elements.defaultSeed.value=modelValue(model.default_seed);el('model-dialog-title').textContent='Edit model';el('model-submit').textContent='Save model';setModelPending(false);clearDialogStatus('model-dialog-status');openDialog(el('model-dialog'),triggerReference(actionButtons.get(key),key,el('create-model')),form.elements.modelName)}
  function modelPayload(form){const input=String(form.get('inputPrice')),output=String(form.get('outputPrice'));return{model_name:form.get('modelName'),display_name:form.get('displayName'),provider_id:discovery?discovery.providerId:Number(form.get('providerId')),max_tokens:Number(form.get('maxTokens')),input_cost_per_million:nullableNumber(input),output_cost_per_million:nullableNumber(output),context_window:nullableNumber(form.get('contextWindow')),default_temperature:nullableNumber(form.get('defaultTemperature')),default_top_p:nullableNumber(form.get('defaultTopP')),default_presence_penalty:nullableNumber(form.get('defaultPresencePenalty')),default_frequency_penalty:nullableNumber(form.get('defaultFrequencyPenalty')),default_seed:nullableNumber(form.get('defaultSeed'))}}
  function setProviderCreateFields(creating){const form=el('provider-form');el('provider-preset-field').classList.toggle('hidden',!creating);form.elements.preset.disabled=!creating;el('provider-env-field').classList.toggle('hidden',!creating);form.elements.envName.disabled=!creating}
  function openProviderCreate(trigger){if(resourceDialogEntryBlocked())return;const form=el('provider-form');form.reset();form.elements.providerId.value='';setProviderCreateFields(true);form.elements.storedKey.disabled=false;form.elements.removeStoredKey.disabled=true;el('provider-dialog-title').textContent='Create provider';el('provider-submit').textContent='Create provider';setProviderPending(false);clearDialogStatus('provider-dialog-status');openDialog(el('provider-dialog'),triggerReference(trigger,null,el('create-provider')),form.elements.preset)}
  function openProviderEdit(provider){if(resourceDialogEntryBlocked())return;const form=el('provider-form'),key=`provider:${provider.id}:edit`;form.reset();form.elements.providerId.value=String(provider.id);form.elements.providerName.value=provider.provider_name;form.elements.displayName.value=provider.display_name;form.elements.baseUrl.value=provider.base_url;form.elements.authType.value=provider.auth_type;setProviderCreateFields(false);form.elements.storedKey.value='';form.elements.storedKey.disabled=false;form.elements.removeStoredKey.disabled=false;form.elements.removeStoredKey.checked=false;el('provider-dialog-title').textContent='Edit provider';el('provider-submit').textContent='Save provider';setProviderPending(false);clearDialogStatus('provider-dialog-status');openDialog(el('provider-dialog'),triggerReference(actionButtons.get(key),key,el('create-provider')),form.elements.providerName)}
  function providerPayload(form,editing){const body={provider_name:form.get('providerName'),display_name:form.get('displayName'),base_url:form.get('baseUrl'),auth_type:form.get('authType')};if(!editing){body.api_key_env_name=form.get('envName');body.stored_api_key=form.get('storedKey');return body}const replacement=String(form.get('storedKey')||'');if(form.get('removeStoredKey')==='on')body.stored_api_key=null;else if(replacement)body.stored_api_key=replacement;return body}
  function table(caption, headers, rows) {
    if (!rows.length) return node('p', T.empty, 'empty');
    const wrap = node('div', undefined, 'table-wrap');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', caption);
    const result = node('table');
    result.append(node('caption', caption, 'visually-hidden'));
    const head = node('thead');
    const headRow = node('tr');
    headers.forEach((header) => {
      const cell = node('th', header);
      cell.setAttribute('scope', 'col');
      headRow.append(cell);
    });
    head.append(headRow);
    result.append(head);
    const body = node('tbody');
    rows.forEach((cells) => {
      const row = node('tr');
      cells.forEach((cell) => {
        const tableCell = node('td');
        tableCell.append(cell instanceof Node ? cell : document.createTextNode(String(cell)));
        row.append(tableCell);
      });
      body.append(row);
    });
    result.append(body);
    wrap.append(result);
    return wrap;
  }

  function statusBadge(active, label = active ? 'Active' : 'Inactive') {
    return node('span', label, 'badge' + (active ? ' active' : ''));
  }

  function filterStatus(filter) {
    if (!filter.is_active) return 'Inactive';
    if (filter.is_global) return 'Active globally';
    const assigned = Array.isArray(filter.model_ids) ? filter.model_ids.length : 0;
    return assigned ? 'Active for ' + assigned + ' models' : 'Active but no models assigned';
  }
  function overviewResourceCounts() {
    const activeProviderIds = new Set(
      state.providers.filter((provider) => provider.is_active).map((provider) => provider.id),
    );
    const availableModels = state.models.filter(
      (model) => model.is_active && activeProviderIds.has(model.provider_id),
    );
    const availableModelIds = new Set(availableModels.map((model) => model.id));
    return {
      users: state.users.filter((user) => user.is_active && user.permissions_valid).length,
      policies: (state.builtInPii && state.builtInPii.is_active ? 1 : 0)
        + state.filters.filter((filter) => {
          if (!filter.is_active) return false;
          if (filter.is_global) return true;
          return (filter.model_ids || []).some((modelId) => availableModelIds.has(modelId));
        }).length,
      models: availableModels.length,
      providers: activeProviderIds.size,
    };
  }
  function providerHealthText(provider) {
    const parts = [provider.health_status || 'Unknown'];
    if (provider.last_health_latency_ms !== null && provider.last_health_latency_ms !== undefined) {
      parts.push(number(provider.last_health_latency_ms) + ' ms');
    }
    if (provider.last_health_check) parts.push(formatDate(provider.last_health_check));
    if (!provider.is_active) parts.push('Inactive');
    return parts.join(' \u00b7 ');
  }
  function renderOverviewConfiguration() {
    const counts = overviewResourceCounts();
    for (const name of ['users', 'policies', 'models', 'providers']) {
      el('overview-' + name + '-count').textContent = String(counts[name]);
    }
    if (!state.providers.length) {
      el('overview-providers-content').replaceChildren(node('p', T.empty, 'empty'));
      return;
    }
    const list = node('ul', undefined, 'provider-snapshot');
    state.providers.forEach((provider) => {
      const item = node('li');
      item.append(
        node('strong', provider.display_name || provider.provider_name),
        node('span', providerHealthText(provider), 'operational-value'),
      );
      list.append(item);
    });
    el('overview-providers-content').replaceChildren(list);
  }
  function statsPath(){const form=new FormData(el('stats-form')),range=String(form.get('range'));const query=new URLSearchParams({range});if(range==='custom'){query.set('start',String(form.get('start')));query.set('end',String(form.get('end')))}return `/admin/stats?${query}`}
  async function loadAll(){showStatus(T.loading);const[users,models,providers,filters,builtInPii,onboarding,presets]=await Promise.all([api('/admin/users'),api('/admin/models'),api('/admin/providers'),api('/admin/filters'),api('/admin/filters/built-in-pii'),api('/admin/onboarding'),api('/admin/provider-presets')]);state.users=users;state.models=models;state.providers=providers;state.filters=filters;state.builtInPii=builtInPii;state.presets=presets;renderOverviewConfiguration();actionButtons.clear();renderUsers();renderModels();renderProviders();populateFilterModels();renderBuiltInPii();renderFilters();renderOnboarding(onboarding);populateProviders();populatePresets();clearStatus()}
  async function loadStats(){renderStats(await api(statsPath()))}
  async function loadInitial(){const[configuration,statistics]=await Promise.allSettled([loadAll(),loadStats()]);if(configuration.status==='rejected')throw configuration.reason;if(statistics.status==='rejected')throw statistics.reason}
  function renderOnboarding(onboarding){const section=el('onboarding');section.classList.toggle('hidden',onboarding.complete);const list=node('ol');onboarding.steps.forEach((step)=>list.append(node('li',`${step.complete?'✓':'○'} ${step.label}`)));const example=node('pre',onboarding.example);el('onboarding-content').replaceChildren(list,example)}
  function renderUsers(){const rows=state.users.map((user)=>{const actions=node('div',undefined,'actions');actions.append(actionButton(`user:${user.id}:edit`,'Edit',()=>openUserEdit(user)));actions.append(actionButton(`user:${user.id}:active`,user.is_active?'Deactivate':'Activate',()=>toggleUser(user),user.is_active?'danger':'secondary'));actions.append(actionButton(`user:${user.id}:rotate`,'Rotate token',()=>rotateToken(user),'secondary'));const access=!user.permissions_valid?'Invalid (access denied)':(user.allowed_models&&user.allowed_models.length?user.allowed_models.join(', '):'All active models');return[user.username,statusBadge(user.is_active),quota(user.max_daily_input_tokens),quota(user.max_daily_output_tokens),access,formatDate(user.created_at),actions]});el('users-content').replaceChildren(table('Users',['Username','Status','Input quota','Output quota','Models','Created','Actions'],rows))}
  async function toggleUser(user){const key=`user:${user.id}:active`,reference=triggerReference(actionButtons.get(key),key,el('create-user'));if(user.is_active){openConfirmation({trigger:reference,title:'Deactivate user',message:`Deactivate user "${user.username}"?`,submitLabel:'Deactivate user',action:()=>api(`/admin/users/${user.id}`,{method:'DELETE'}),onSuccess:()=>refreshAfterMutation(reference,el('create-user'),T.saved),fallback:el('create-user')});return}try{await api(`/admin/users/${user.id}`,{method:'PUT',body:JSON.stringify({is_active:true})});await refreshAfterMutation(reference,el('create-user'),T.saved)}catch(error){showStatus(error.message,'error')}}
  function rotateToken(user){const key=`user:${user.id}:rotate`,reference=triggerReference(actionButtons.get(key),key,el('create-user'));openConfirmation({trigger:reference,title:'Rotate user token',message:`Rotate the token for "${user.username}"? The previous token will stop working immediately.`,submitLabel:'Rotate token',action:()=>api(`/admin/users/${user.id}/rotate-token`,{method:'POST'}),onSuccess:async(result)=>{try{await loadAll();showStatus(T.rotated,'success')}catch(error){showStatus(error.message,'error')}showUserTokenResult(result.apiToken,'Token rotated',reference)},fallback:el('create-user')})}
  function renderModels(){const rows=state.models.map((model)=>{const actions=node('div',undefined,'actions');actions.append(actionButton(`model:${model.id}:edit`,'Edit',()=>openModelEdit(model)));actions.append(actionButton(`model:${model.id}:active`,model.is_active?'Deactivate':'Activate',()=>toggleModel(model),model.is_active?'danger':'secondary'));actions.append(actionButton(`model:${model.id}:delete`,'Delete',()=>deleteModel(model),'danger'));return[model.model_name,model.display_name,model.provider_name||'—',number(model.max_tokens),model.context_window===null?T.notConfigured:number(model.context_window),model.input_cost_per_million===null?T.notConfigured:money(model.input_cost_per_million,true),model.output_cost_per_million===null?T.notConfigured:money(model.output_cost_per_million,true),statusBadge(model.is_active),actions]});el('models-content').replaceChildren(table('Models',['Identifier','Name','Provider','Max output','Context','Input / 1M','Output / 1M','Status','Actions'],rows))}
  async function toggleModel(model){const key=`model:${model.id}:active`,reference=triggerReference(actionButtons.get(key),key,el('create-model'));if(model.is_active){openConfirmation({trigger:reference,title:'Deactivate model',message:`Deactivate model "${model.model_name}"?`,submitLabel:'Deactivate model',action:()=>api(`/admin/models/${model.id}`,{method:'PUT',body:JSON.stringify({is_active:false})}),onSuccess:()=>refreshAfterMutation(reference,el('create-model'),T.saved),fallback:el('create-model')});return}try{await api(`/admin/models/${model.id}`,{method:'PUT',body:JSON.stringify({is_active:true})});await refreshAfterMutation(reference,el('create-model'),T.saved)}catch(error){showStatus(error.message,'error')}}
  function deleteModel(model){const key=`model:${model.id}:delete`,reference=triggerReference(actionButtons.get(key),key,el('create-model'));openConfirmation({trigger:reference,title:'Delete model',message:`Delete model "${model.model_name}" permanently?`,submitLabel:'Delete model',action:()=>api(`/admin/models/${model.id}`,{method:'DELETE'}),onSuccess:()=>refreshAfterMutation(null,el('create-model'),T.saved),fallback:el('create-model')})}
  function renderProviders(){const rows=state.providers.map((provider)=>{const actions=node('div',undefined,'actions');actions.append(actionButton(`provider:${provider.id}:edit`,'Edit',()=>openProviderEdit(provider)));actions.append(actionButton(`provider:${provider.id}:test`,'Test',async()=>{const result=await api(`/admin/providers/${provider.id}/test`,{method:'POST'});showStatus(result.message||result.error||result.status,result.status==='healthy'?'success':'error');await loadAll()}));actions.append(actionButton(`provider:${provider.id}:discover`,'Discover models',()=>discoverModels(provider),'secondary'));actions.append(actionButton(`provider:${provider.id}:active`,provider.is_active?'Deactivate':'Activate',()=>toggleProvider(provider),provider.is_active?'danger':'secondary'));actions.append(actionButton(`provider:${provider.id}:delete`,'Delete',()=>deleteProvider(provider),'danger'));const health=provider.last_health_check?`${provider.health_status} · ${number(provider.last_health_latency_ms)} ms · ${formatDate(provider.last_health_check)}`:provider.health_status;return[provider.provider_name,provider.display_name,provider.base_url,provider.auth_type,provider.hasApiKey?'Configured':'None',health,statusBadge(provider.is_active),actions]});el('providers-content').replaceChildren(table('Providers',['Identifier','Name','URL','Auth','Credential','Last health check','Status','Actions'],rows))}
  async function discoverModels(provider){if(resourceDialogEntryBlocked())return;const key=`provider:${provider.id}:discover`,request={key};pendingDiscoveryRequest=request;try{const models=await api(`/admin/providers/${provider.id}/discover-models`);if(pendingDiscoveryRequest!==request)return;pendingDiscoveryRequest=null;if(!models.length){showStatus('No unregistered models were found.','success');return}if(!openModelCreate(actionButtons.get(key),key))return;const names=models.map((model)=>model.model_name);discovery={providerId:provider.id,names:new Set(names)};const form=el('model-form');form.elements.providerId.value=String(provider.id);form.elements.providerId.disabled=true;form.elements.modelName.value=names[0];form.elements.displayName.value=names[0];el('model-discovery-list').replaceChildren(...names.map((name)=>node('li',name)));el('model-discovery').classList.remove('hidden')}catch(error){if(pendingDiscoveryRequest!==request)return;pendingDiscoveryRequest=null;showStatus(error.message,'error')}}
  async function toggleProvider(provider){const key=`provider:${provider.id}:active`,reference=triggerReference(actionButtons.get(key),key,el('create-provider'));if(provider.is_active){openConfirmation({trigger:reference,title:'Deactivate provider',message:`Deactivate provider "${provider.provider_name}"?`,submitLabel:'Deactivate provider',action:()=>api(`/admin/providers/${provider.id}`,{method:'PUT',body:JSON.stringify({is_active:false})}),onSuccess:()=>refreshAfterMutation(reference,el('create-provider'),T.saved),fallback:el('create-provider')});return}try{await api(`/admin/providers/${provider.id}`,{method:'PUT',body:JSON.stringify({is_active:true})});await refreshAfterMutation(reference,el('create-provider'),T.saved)}catch(error){showStatus(error.message,'error')}}
  function deleteProvider(provider){const key=`provider:${provider.id}:delete`,reference=triggerReference(actionButtons.get(key),key,el('create-provider'));openConfirmation({trigger:reference,title:'Delete provider',message:`Delete provider "${provider.provider_name}" permanently?`,submitLabel:'Delete provider',action:()=>api(`/admin/providers/${provider.id}`,{method:'DELETE'}),onSuccess:()=>refreshAfterMutation(null,el('create-provider'),T.saved),fallback:el('create-provider')})}
  function filterScope(filter){if(filter.is_global)return 'Global';if(!filter.model_ids.length)return 'No models';return filter.model_ids.map((modelId)=>{const model=state.models.find((item)=>item.id===modelId);return model?model.model_name:String(modelId)}).join(', ')}
  function renderFilters(){const rows=state.filters.map((filter)=>{const actions=node('div',undefined,'actions');actions.append(button('Edit',()=>editFilter(filter)));actions.append(button('Delete',()=>deleteFilter(filter),'danger'));return[filter.name,number(filter.patterns.length),filter.input_action||'None',filter.output_action||'None',filterScope(filter),statusBadge(filter.is_active,filterStatus(filter)),formatDate(filter.updated_at),actions]});el('filters-content').replaceChildren(table('Filters',['Name','Patterns','Input','Output','Scope','Status','Updated','Actions'],rows))}
  function populateFilterModels(){const select=el('filter-form').elements.modelIds,selected=new Set(Array.from(select.selectedOptions,(option)=>Number(option.value)));select.replaceChildren();state.models.forEach((model)=>{const option=node('option',`${model.display_name} (${model.model_name})`);option.value=String(model.id);option.selected=selected.has(model.id);select.append(option)})}
  function renderBuiltInPii(){const filter=state.builtInPii,form=el('built-in-pii-form');form.elements.isActive.checked=filter.is_active;const stateNode=el('built-in-pii-state');stateNode.textContent=filter.is_active?'Active':'Inactive';stateNode.className='badge'+(filter.is_active?' active':'');const items=filter.rules.map((rule)=>node('li',rule.label+' - '+(rule.mode==='restore'?'request-scoped restoration':'irreversible redaction')));el('built-in-pii-rules').replaceChildren(...items)}

  function syncFilterModelScope(){const form=el('filter-form'),global=form.elements.isGlobal.checked,select=form.elements.modelIds;select.disabled=global;select.setAttribute('aria-disabled',String(global))}
  function resetFilterForm(focusName=false){const form=el('filter-form');form.reset();form.elements.filterId.value='';el('filter-form-title').textContent='Create filter';el('filter-submit').textContent='Create filter';el('filter-cancel').classList.add('hidden');syncFilterModelScope();if(focusName)form.elements.name.focus()}
  function editFilter(filter){const form=el('filter-form');form.elements.filterId.value=String(filter.id);form.elements.name.value=filter.name;form.elements.patterns.value=filter.patterns.join('\n');form.elements.inputAction.value=filter.input_action||'';form.elements.outputAction.value=filter.output_action||'';form.elements.isGlobal.checked=filter.is_global;form.elements.isActive.checked=filter.is_active;Array.from(form.elements.modelIds.options).forEach((option)=>{option.selected=filter.model_ids.includes(Number(option.value))});syncFilterModelScope();el('filter-form-title').textContent='Edit filter';el('filter-submit').textContent='Save filter';el('filter-cancel').classList.remove('hidden');form.elements.name.focus()}
  async function deleteFilter(filter){if(!window.confirm('Delete this filter permanently?'))return;await api(`/admin/filters/${filter.id}`,{method:'DELETE'});resetFilterForm();showStatus(T.saved,'success');await loadAll()}
  function filterPayload(form){const global=form.get('isGlobal')==='on';return{name:form.get('name'),patterns:String(form.get('patterns')).split(/\r?\n/u).map((value)=>value.trim()).filter(Boolean),input_action:form.get('inputAction')||null,output_action:form.get('outputAction')||null,is_active:form.get('isActive')==='on',is_global:global,model_ids:global?[]:form.getAll('modelIds').map(Number)}}
  function aggregateTable(rows,label){return table(label+' usage',[label,'Requests','Success','Failure','Error rate','Input','Output','Total','Average','p95','Estimated cost'],rows.map((row)=>[row.name,number(row.total_requests),number(row.successful_requests),number(row.failed_requests),`${Number(row.error_rate).toFixed(1)}%`,number(row.total_input),number(row.total_output),number(row.total_tokens),`${number(Math.round(row.average_response_time_ms))} ms`,`${number(row.p95_response_time_ms)} ms`,money(row.estimated_cost_usd,row.cost_configured)]))}
  function renderStats(stats){const summary=stats.summary,cards=node('div',undefined,'stats');[['Requests',number(summary.total_requests)],['Success',number(summary.successful_requests)],['Failure',number(summary.failed_requests)],['Error rate',`${Number(summary.error_rate).toFixed(1)}%`],['Input tokens',number(summary.total_input)],['Output tokens',number(summary.total_output)],['Total tokens',number(summary.total_tokens)],['Average response',`${number(Math.round(summary.average_response_time_ms))} ms`],['p95 response',`${number(summary.p95_response_time_ms)} ms`],['Estimated cost',money(summary.estimated_cost_usd,summary.cost_configured)]].forEach(([label,value])=>{const card=node('div',undefined,'metric');card.append(node('strong',value),node('span',label));cards.append(card)});cards.append(node('p',`${formatDate(stats.period.start)} – ${formatDate(stats.period.end)} · Updated ${formatDate(stats.generated_at)}`));el('stats-content').replaceChildren(cards);el('usage-content').replaceChildren(aggregateTable(stats.by_user,'User'));el('model-stats-content').replaceChildren(aggregateTable(stats.by_model,'Model'));el('provider-stats-content').replaceChildren(aggregateTable(stats.by_provider,'Provider'));const recent=stats.recent_requests.map((row)=>[formatDate(row.created_at),row.username||String(row.user_id),row.model_name,row.provider_id===null?'—':String(row.provider_id),row.status,row.error_type||'—',number(row.input_tokens),number(row.output_tokens),`${number(row.response_time_ms)} ms`,money(row.estimated_cost_usd,row.cost_configured)]);el('request-content').replaceChildren(table('Recent requests',['Time','User','Model','Provider ID','Status','Error type','Input','Output','Response','Estimated cost'],recent))}
  function populateProviders(){const select=el('model-form').elements.providerId;select.replaceChildren();state.providers.forEach((provider)=>{const option=node('option',`${provider.display_name} (${provider.provider_name})`);option.value=String(provider.id);select.append(option)})}
  function populatePresets(){const select=el('provider-form').elements.preset;select.replaceChildren();const custom=node('option','Custom');custom.value='';select.append(custom);state.presets.forEach((preset)=>{const option=node('option',preset.name);option.value=preset.id;select.append(option)})}
  document.querySelectorAll('nav [data-tab]').forEach((item)=>item.addEventListener('click',()=>selectSection(item.dataset.tab)));
  document.querySelectorAll('[data-overview-target]').forEach((item) => {
    item.addEventListener('click', () => {
      const target = item.dataset.overviewTarget;
      selectSection(target);
      el('tab-button-' + target).focus();
    });
  });
  el('create-user').addEventListener('click',(event)=>openUserCreate(event.currentTarget));
  el('create-model').addEventListener('click',(event)=>openModelCreate(event.currentTarget));
  el('create-provider').addEventListener('click',(event)=>openProviderCreate(event.currentTarget));
  el('user-cancel').addEventListener('click',()=>{if(!pendingUserOperation)closeDialog(el('user-dialog'))});
  el('model-cancel').addEventListener('click',()=>closeDialog(el('model-dialog')));
  el('provider-cancel').addEventListener('click',()=>{if(!pendingProviderOperation)closeDialog(el('provider-dialog'))});
  el('confirm-cancel').addEventListener('click',()=>{if(!pendingConfirmationOperation)closeDialog(el('confirm-dialog'))});
  el('user-token-close').addEventListener('click',()=>{if(!pendingUserOperation)closeDialog(el('user-dialog'))});
  el('user-dialog').addEventListener('cancel',(event)=>{if(pendingUserOperation)event.preventDefault()});
  el('model-dialog').addEventListener('cancel',(event)=>{if(pendingModelOperation)event.preventDefault()});
  el('provider-dialog').addEventListener('cancel',(event)=>{if(pendingProviderOperation)event.preventDefault()});
  el('confirm-dialog').addEventListener('cancel',(event)=>{if(pendingConfirmationOperation)event.preventDefault()});
  el('user-dialog').addEventListener('close',()=>handleDialogClose('user-dialog-status',()=>{const form=el('user-form');el('user-token-value').textContent='';el('user-token-result').classList.add('hidden');form.classList.remove('hidden');form.elements.username.disabled=false;if(!pendingUserOperation)setUserPending(false)}));
  el('model-dialog').addEventListener('close',()=>handleDialogClose('model-dialog-status',()=>{resetModelDiscovery();el('model-advanced').open=false;if(!pendingModelOperation)setModelPending(false)}));
  el('provider-dialog').addEventListener('close',()=>handleDialogClose('provider-dialog-status',()=>{const form=el('provider-form');form.elements.storedKey.value='';form.elements.storedKey.disabled=false;form.elements.removeStoredKey.checked=false;form.elements.removeStoredKey.disabled=false;if(!pendingProviderOperation)setProviderPending(false)}));
  el('confirm-dialog').addEventListener('close',()=>handleDialogClose('confirm-dialog-status',()=>{if(!pendingConfirmationOperation){pendingConfirmation=null;setConfirmationPending(false)}}));
  el('login-form').addEventListener('submit',async(event)=>{event.preventDefault();state.key=el('admin-key').value;el('admin-key').value='';try{await api('/admin/users');showDashboard();showStatus(T.signedIn,'success');await loadInitial()}catch(error){if(state.key)showStatus(error.message,'error')}});
  el('sign-out').addEventListener('click',()=>{state.key='';showLogin();showStatus(T.signedOut,'success')});
  el('user-token-copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(el('user-token-value').textContent);showDialogStatus('user-dialog-status','Token copied.','success')}catch(error){showDialogStatus('user-dialog-status',error.message)}});
  el('confirm-form').addEventListener('submit',async(event)=>{event.preventDefault();const submit=el('confirm-submit');if(submit.disabled||pendingConfirmationOperation||!pendingConfirmation)return;const confirmation=pendingConfirmation,operation={confirmation};pendingConfirmationOperation=operation;setConfirmationPending(true);try{const result=await confirmation.action();if(pendingConfirmationOperation!==operation)return;closeDialog(el('confirm-dialog'),false);await confirmation.onSuccess(result);if(pendingConfirmationOperation!==operation)return;pendingConfirmationOperation=null;pendingConfirmation=null;setConfirmationPending(false)}catch(error){if(pendingConfirmationOperation!==operation)return;pendingConfirmationOperation=null;showDialogStatus('confirm-dialog-status',error.message);setConfirmationPending(false)}});
  el('user-form').addEventListener('submit',async(event)=>{event.preventDefault();const formElement=event.currentTarget,submit=el('user-submit');if(submit.disabled||pendingUserOperation)return;const operation={};pendingUserOperation=operation;setUserPending(true);const form=new FormData(formElement),userId=String(formElement.elements.userId.value),body={max_daily_input_tokens:Number(form.get('inputQuota')),max_daily_output_tokens:Number(form.get('outputQuota')),allowed_models:String(form.get('allowedModels')).split(',').map((value)=>value.trim()).filter(Boolean)},reference=userId?triggerReference(null,`user:${userId}:edit`,el('create-user')):activeDialogTrigger;if(!userId)body.username=form.get('username');try{const result=await api(userId?`/admin/users/${userId}`:'/admin/users',{method:userId?'PUT':'POST',body:JSON.stringify(body)});if(pendingUserOperation!==operation)return;if(userId){closeDialog(el('user-dialog'),false);await refreshAfterMutation(reference,el('create-user'),T.saved);if(pendingUserOperation!==operation)return;pendingUserOperation=null;setUserPending(false);return}pendingUserOperation=null;showUserTokenResult(result.apiToken,'User created',reference);try{await loadAll();showStatus(T.created,'success')}catch(error){showStatus(error.message,'error')}}catch(error){if(pendingUserOperation!==operation)return;pendingUserOperation=null;showDialogStatus('user-dialog-status',error.message);setUserPending(false)}});
  el('model-form').addEventListener('submit',async(event)=>{event.preventDefault();const formElement=event.currentTarget,submit=el('model-submit');if(submit.disabled||pendingModelOperation||!el('model-dialog').open)return;const form=new FormData(formElement),body=modelPayload(form),modelId=String(formElement.elements.modelId.value),reference=modelId?triggerReference(null,`model:${modelId}:edit`,el('create-model')):activeDialogTrigger;if(discovery&&!discovery.names.has(body.model_name)){showDialogStatus('model-dialog-status','Choose a discovered identifier from the list.');return}const operation={};pendingModelOperation=operation;setModelPending(true);try{await api(modelId?`/admin/models/${modelId}`:'/admin/models',{method:modelId?'PUT':'POST',body:JSON.stringify(body)});if(pendingModelOperation!==operation)return;closeDialog(el('model-dialog'),false);await refreshAfterMutation(reference,el('create-model'),modelId?T.saved:T.created);if(pendingModelOperation!==operation)return;pendingModelOperation=null;setModelPending(false)}catch(error){if(pendingModelOperation!==operation)return;pendingModelOperation=null;showDialogStatus('model-dialog-status',error.message);setModelPending(false)}});
  el('provider-form').addEventListener('submit',async(event)=>{event.preventDefault();const formElement=event.currentTarget,submit=el('provider-submit');if(submit.disabled||pendingProviderOperation||!el('provider-dialog').open)return;const form=new FormData(formElement),providerId=String(formElement.elements.providerId.value),body=providerPayload(form,Boolean(providerId)),reference=providerId?triggerReference(null,`provider:${providerId}:edit`,el('create-provider')):activeDialogTrigger,operation={};pendingProviderOperation=operation;setProviderPending(true);try{await api(providerId?`/admin/providers/${providerId}`:'/admin/providers',{method:providerId?'PUT':'POST',body:JSON.stringify(body)});if(pendingProviderOperation!==operation)return;closeDialog(el('provider-dialog'),false);await refreshAfterMutation(reference,el('create-provider'),providerId?T.saved:T.created);if(pendingProviderOperation!==operation)return;pendingProviderOperation=null;setProviderPending(false)}catch(error){if(pendingProviderOperation!==operation)return;pendingProviderOperation=null;showDialogStatus('provider-dialog-status',error.message);setProviderPending(false)}});
  el('provider-form').elements.preset.addEventListener('change',(event)=>{const preset=state.presets.find((item)=>item.id===event.target.value);if(!preset)return;const form=el('provider-form');form.elements.providerName.value=preset.id;form.elements.displayName.value=preset.name;form.elements.baseUrl.value=preset.base_url});
  el('provider-form').elements.removeStoredKey.addEventListener('change',(event)=>{const secret=el('provider-form').elements.storedKey;if(event.target.checked){secret.value='';secret.disabled=true}else secret.disabled=false});
  el('provider-form').elements.storedKey.addEventListener('input',()=>{const form=el('provider-form');if(form.elements.storedKey.value)form.elements.removeStoredKey.checked=false});
  el('filter-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget),filterId=String(form.get('filterId'));try{await api(filterId?`/admin/filters/${filterId}`:'/admin/filters',{method:filterId?'PUT':'POST',body:JSON.stringify(filterPayload(form))});resetFilterForm();showStatus(filterId?T.saved:T.created,'success');await loadAll()}catch(error){showStatus(error.message,'error')}});
  el('built-in-pii-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget,isActive=form.elements.isActive.checked;try{await api('/admin/filters/built-in-pii',{method:'PUT',body:JSON.stringify({is_active:isActive})});await loadAll();showStatus(T.saved,'success')}catch(error){showStatus(error.message,'error')}});

  el('filter-cancel').addEventListener('click',()=>resetFilterForm(true));
  el('filter-form').elements.isGlobal.addEventListener('change',syncFilterModelScope);
  el('stats-form').addEventListener('submit',async(event)=>{event.preventDefault();try{showStatus(T.loading);await loadStats();clearStatus()}catch(error){showStatus(error.message,'error')}});
  window.addEventListener('unhandledrejection',(event)=>showStatus(event.reason&&event.reason.message?event.reason.message:T.requestFailed,'error'));
  showLogin();
