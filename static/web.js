'use strict';

function initialize() {
	const sContent = document.getElementById('shellContent');
	const sInput = document.getElementById('shellInput');
	const sStatus = document.getElementById('statusContainer');

	const worker = new Worker('static/worker.js');

	worker.onmessage = msg => {
		msg = msg.data;
		switch(msg[0]) {
			case 'status':
				sStatus.innerHTML = msg[1];
				document.title = msg[2];
				break;
			case 'shell':
				sContent.innerHTML += msg[1];
				sContent.scrollTop = sContent.scrollHeight - sContent.clientHeight;
				break;
			case 'init':
				worker.postMessage(['init', document.location.host]);
				break;
			case 'reload':
				document.location.reload();
				break;
		}
	};

	function addContent(content) {
		sContent.innerHTML += content + '\n';

		sContent.scrollTop = sContent.scrollHeight - sContent.clientHeight;
	}

	sInput.addEventListener('keyup', e => {
		if (e.keyCode === 10 || e.keyCode === 13) {
			const t = sInput.value.trim();
			if (t === 'clear') {
				sContent.innerHTML = '';
			}
			sInput.value = '';
			const i = t.indexOf(' ');
			let cmd, args;
			if (i >= 0) {
				cmd = t.substr(0, i);
				args = t.substr(i + 1);
			} else {
				cmd = t;
				args = '';
			}
			addContent(`> ${t}`);
			if (cmd === 'user') {
				if (args !== '') {
					worker.postMessage(['user',args]);
					return;
				}
				worker.postMessage(['lsuser']);
				return;
			} else if (cmd === 'create_user') {
				worker.postMessage(['mkuser', args]);
				return;
			} else if (cmd === 'retire_user') {
				worker.postMessage(['rmuser', args]);
				return;
			}
			worker.postMessage(['command',cmd,args]);
		}
	});
}