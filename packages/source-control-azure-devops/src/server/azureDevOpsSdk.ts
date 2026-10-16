// `az devops invoke` selects the first of equally versioned routes with the same resource name.
// Use its installed SDK and credentials when a PR update must target one specific route.
export const PATCH_PULL_REQUEST_SCRIPT = String.raw`
import sys,json
from azure.cli.core import get_default_cli
from azure.cli.core.extension import get_extension
get_default_cli()
sys.path.insert(0,get_extension('azure-devops').path)
from azext_devops.dev.common.services import get_git_client,resolve_instance
request=json.load(sys.stdin)
client=get_git_client(resolve_instance(detect=True,organization=None))
with open(request['bodyFile'],encoding='utf-8') as body_file:
    body=json.load(body_file)
response=client._send(http_method='PATCH',location_id='9946fd70-0d40-406e-b686-b4744cbbcc37',version='7.1',route_values=request['routeValues'],content=body)
print(json.dumps(response.json()))
`;

export const AUTHENTICATED_IDENTITY_SCRIPT = String.raw`
import sys,json
from azure.cli.core import get_default_cli
from azure.cli.core.extension import get_extension
get_default_cli()
sys.path.insert(0,get_extension('azure-devops').path)
from azext_devops.dev.common.services import get_connection_data,resolve_instance
identity=get_connection_data(resolve_instance(detect=True,organization=None)).authenticated_user
print(json.dumps({'id':identity.id,'login':identity.properties.get('Account',{}).get('$value',''),'name':identity.provider_display_name}))
`;

export const NOTIFICATION_SUBSCRIPTIONS_SCRIPT = String.raw`
import sys,json
from azure.cli.core import get_default_cli
from azure.cli.core.extension import get_extension
get_default_cli()
sys.path.insert(0,get_extension('azure-devops').path)
from azext_devops.dev.common.services import get_connection,resolve_instance
request=json.load(sys.stdin)
client=get_connection(resolve_instance(detect=True,organization=None)).get_client('azext_devops.devops_sdk.v5_0.notification.notification_client.NotificationClient')
body=None
if request.get('bodyFile'):
    with open(request['bodyFile'],encoding='utf-8') as body_file:
        body=json.load(body_file)
response=client._send(http_method=request['method'],location_id='70f911d6-abac-488c-85b3-a206bf57e165',version='7.1',route_values={'subscriptionId':request['subscriptionId']} if request.get('subscriptionId') else {},query_parameters={'targetId':request['viewerId']} if request.get('viewerId') else {},content=body)
print(json.dumps(response.json() if response.content else {}))
`;

export function withAzureSdkErrors(script: string): string {
  return `import json
try:
${script
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
except Exception as error:
    from azext_devops.devops_sdk.exceptions import AzureDevOpsAuthenticationError,AzureDevOpsServiceError
    if not isinstance(error,(AzureDevOpsAuthenticationError,AzureDevOpsServiceError)):
        raise
    print(json.dumps({'_t3SdkError':{'message': 'Azure refused this operation. Check that the signed-in credential has the required Azure DevOps scope and permission.' if isinstance(error,AzureDevOpsAuthenticationError) else str(error)[:2048]}}))
`;
}

export const UPLOAD_ATTACHMENT_SCRIPT = String.raw`
import sys,json,base64
from urllib.parse import quote
from azure.cli.core import get_default_cli
from azure.cli.core.extension import get_extension
get_default_cli()
sys.path.insert(0,get_extension('azure-devops').path)
from azext_devops.dev.common.services import get_git_client,resolve_instance
request=json.load(sys.stdin)
content=base64.b64decode(request['data'],validate=True)
if len(content)>10*1024*1024:
    raise ValueError('Attachments must be 10 MB or smaller.')
client=get_git_client(resolve_instance(detect=True,organization=None))
routes=request['routeValues']
routes['fileName']=quote(request['fileName'],safe='')
response=client._send(http_method='POST',location_id='965d9361-878b-413b-a494-45d5b5fd8ab7',version='7.1',route_values=routes,content=content,media_type='application/octet-stream')
print(json.dumps(response.json()))
`;

export const RESOLVE_IDENTITIES_SCRIPT = String.raw`
import sys,json
from azure.cli.core import get_default_cli
from azure.cli.core.extension import get_extension
get_default_cli()
sys.path.insert(0,get_extension('azure-devops').path)
from azext_devops.dev.common.services import get_identity_client,resolve_instance
request=json.load(sys.stdin)
client=get_identity_client(resolve_instance(detect=True,organization=None))
identities=[]
for start in range(0,len(request['descriptors']),40):
    identities.extend(client.read_identities(subject_descriptors=','.join(request['descriptors'][start:start+40]),query_membership='None'))
print(json.dumps({'value':[{'id':identity.id,'descriptor':identity.subject_descriptor} for identity in identities]}))
`;

/**
 * Azure's Git security token for a branch: each path segment of the name is hex-encoded UTF-16LE
 * on its own, slashes stay slashes, and the token ends with a slash. A token spelled any other way
 * still evaluates, but only inherits the repository's permissions and misses the branch's own.
 */
export const BRANCH_TOKEN_FUNCTION = String.raw`
def branch_token(root,ref):
    return root+'/refs/heads/'+'/'.join(segment.encode('utf-16-le').hex() for segment in ref.removeprefix('refs/heads/').split('/'))+'/'
`;

export const PULL_REQUEST_CONTEXT_SCRIPT = String.raw`
import sys,json,hashlib
from urllib.parse import quote
from azure.cli.core import get_default_cli
from azure.cli.core.extension import get_extension
get_default_cli()
sys.path.insert(0,get_extension('azure-devops').path)
from azext_devops.dev.common.services import get_connection,resolve_instance
request=json.load(sys.stdin)
org=resolve_instance(detect=True,organization=None).rstrip('/')
connection=get_connection(org)
session=connection._creds.signed_session()
project=quote(request['project'],safe='')
repository=quote(request['repository'],safe='')
number=request['number']
${BRANCH_TOKEN_FUNCTION}
def read(method,path,**kwargs):
    response=session.request(method,org+path,timeout=20,**kwargs)
    if response.status_code in (401,403):
        return {'denied':True}
    if not response.ok:
        print(json.dumps({'_t3SdkError':{'message':'Azure refused the review-context request (HTTP '+str(response.status_code)+').'}}))
        sys.exit(0)
    return response.json() if response.content else {}
if request['operation']=='visit':
    properties={'repositoryId':request['repository'],'pullRequestId':number}
    if 'hashes' in request:
        properties.update({'modifyHashes':request['hashes'],'modifyViewedStatus':2 if request['viewed'] else 1})
    result=read('POST','/_apis/Contribution/HierarchyQuery/project/'+project,params={'api-version':'7.1-preview.1'},json={'contributionIds':['ms.vss-code-web.pr-detail-visit-data-provider'],'dataProviderContext':{'properties':properties}})
    print(json.dumps(result))
else:
    pr=read('GET','/'+project+'/_apis/git/repositories/'+repository+'/pullrequests/'+str(number),params={'api-version':'7.1'})
    if pr.get('denied'):
        print(json.dumps(pr))
    else:
        repo=pr['repository']
        root='repoV2/'+repo['project']['id']+'/'+repo['id']
        source=pr.get('forkSource') or {}
        source_repo=source.get('repository') or repo
        source_root='repoV2/'+source_repo.get('project',repo['project'])['id']+'/'+source_repo['id']
        tokens={'contribute':(16384,root),'complete':(4,branch_token(root,pr['targetRefName'])),'push':(4,branch_token(source_root,source.get('name') or pr['sourceRefName'])),'deleteBranch':(8,branch_token(source_root,source.get('name') or pr['sourceRefName'])),'bypass':(32768,branch_token(root,pr['targetRefName']))}
        permissions={}
        for name,(bit,token) in tokens.items():
            response=read('GET','/_apis/permissions/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87/'+str(bit),params={'tokens':token,'api-version':'7.1'})
            permissions[name]=response.get('value',[None])[0]
        credential=getattr(connection._creds,'password','')
        print(json.dumps({'permissions':permissions,'credentialKey':hashlib.sha256(credential.encode()).hexdigest()}))
`;
