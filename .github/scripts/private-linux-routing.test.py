import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

WORKFLOW = Path(__file__).parents[1] / 'workflows' / 'fork-ci.yml'
TEXT = WORKFLOW.read_text()


def job(name):
    return re.search(rf'^  {name}:\n(.*?)(?=^  [\w-]+:|\Z)', TEXT, re.M | re.S)[1]


def run_block(text):
    return textwrap.dedent(text.split('        run: |\n')[-1])


class RoutingTests(unittest.TestCase):
    def request(self, server_tests, exit_code):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            output.touch()
            script = f'gh() {{ return {exit_code}; }}\n' + run_block(job('private-linux-status'))
            result = subprocess.run(['bash', '-e', '-c', script], capture_output=True, text=True,
                env={**os.environ, 'SERVER_TESTS': server_tests, 'SOURCE_SHA': 'a' * 40,
                     'GITHUB_OUTPUT': str(output), 'GITHUB_REPOSITORY': 'ScriptedAlchemy/t3code',
                     'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
                     'GITHUB_SERVER_URL': 'https://github.com'})
            return result.returncode, output.read_text()

    def test_request_publishes_only_after_success(self):
        self.assertEqual(self.request('true', 0), (0, 'enabled=true\n'))
        code, output = self.request('true', 1)
        self.assertNotEqual(code, 0)
        self.assertEqual(output, '')
        self.assertEqual(self.request('false', 0), (0, 'enabled=false\n'))

    def test_hosted_server_falls_back_on_failed_or_skipped_request(self):
        expression = re.search(r'    if: >-\n(.*?)(?=    runs-on:)', job('server'), re.S)[1].strip()
        expression = expression.replace('needs.private-linux-status', 'needs["private-linux-status"]')
        for result, enabled, tests, cancelled, expected in [
            ('success', 'true', 'true', False, False),
            ('failure', '', 'true', False, True),
            ('failure', 'true', 'true', False, True),
            ('skipped', '', 'true', False, True),
            ('success', 'false', 'true', False, True),
            ('skipped', '', 'false', False, False),
            ('failure', '', 'true', True, False),
        ]:
            with self.subTest(result=result, enabled=enabled, tests=tests, cancelled=cancelled):
                needs = {'changes': {'outputs': {'test_server': tests}},
                         'private-linux-status': {'result': result, 'outputs': {'enabled': enabled}}}
                script = f'const needs={json.dumps(needs)}; const cancelled=()=>{str(cancelled).lower()}; console.log(Boolean({expression}));'
                actual = subprocess.check_output(['node', '-e', script], text=True).strip()
                self.assertEqual(actual, str(expected).lower())

    def test_aggregate_requires_server_or_acknowledged_private_route(self):
        for private_result, enabled, server_result, expected in [
            ('success', 'true', 'skipped', True),
            ('skipped', '', 'success', True),
            ('success', 'false', 'skipped', False),
            ('failure', 'true', 'skipped', False),
            ('success', 'true', 'failure', False),
        ]:
            with self.subTest(private=private_result, enabled=enabled, server=server_result):
                needs = {k: {'result': 'success'} for k in ['checks', 'clients', 'rust', 'mobile_native']}
                needs['changes'] = {'result': 'success', 'outputs': {'test_server': 'true'}}
                needs['private-linux-status'] = {'result': private_result, 'outputs': {'enabled': enabled}}
                needs['server'] = {'result': server_result}
                result = subprocess.run(['bash', '-e', '-c', run_block(job('check'))],
                    env={**os.environ, 'RESULTS': json.dumps(needs)}, capture_output=True)
                self.assertEqual(result.returncode == 0, expected)

    def test_privileged_request_never_checks_out_source(self):
        request = job('private-linux-status')
        self.assertNotRegex(request, r'(?m)^\s+-?\s*uses:')
        self.assertIn("github.actor_id == '25274700'", request)
        self.assertIn("github.triggering_actor == 'ScriptedAlchemy'", request)
        self.assertIn('github.event.pull_request.head.repo.full_name == github.repository', request)
        self.assertNotIn('statuses: write', job('changes'))


if __name__ == '__main__':
    unittest.main()
