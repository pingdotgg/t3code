# Independent Files API consumer

Install this self-contained format-2 package after `installable-files`. Give it the project scope where it will run. It depends on `example.files@^1.0.0` and the namespaced API `example.files/info@^1.0.0`; disabling or removing the provider makes this consumer unavailable. Open **Files API consumer** from Extensions to display metadata returned by the other plugin's API.

The client receives only public SDK host capabilities and the shared React runtime. No private application modules, own subprocess tools or direct transport calls are used. The metadata method requires no operation grant; it still requires an enabled compatible installation and authorized project membership. This example does not grant itself filesystem or work-control authority.
