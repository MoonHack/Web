'use strict';

function initialize() {
	const sCanvas = document.getElementById('shellCanvas');
	const gl = sCanvas.getContext('webgl');
	const sStatus = document.getElementById('statusContainer');

	const sTmpCanvas = document.getElementById('textTempCanvas');
	const sTmpCanvasCtx = sTmpCanvas.getContext('2d');

	const worker = new Worker('static/worker.js');

	let user = '', canInput = false;

	const lineHeight = 12;
	const lineSpacing = 4;
	const totalLineHeight = lineHeight + lineSpacing;

	let lineCount = 20;
	let charsPerLine = 40;

	let cursorPos = 0;
	let typedText = '';
	let cliText = [];
	let lineBuffer = [];
	let renderInProgress = false;
	let cliScreenView = [];

	let texturesToPurge = [];

	const program = webglUtils.createProgramFromScripts(gl, ['2d-vertex-shader','2d-fragment-shader']);
	gl.useProgram(program);
	const aPosition = gl.getAttribLocation(program, 'a_position');
	const aTexPosition = gl.getAttribLocation(program, 'a_tex_position');
	const uResolution = gl.getUniformLocation(program, 'u_resolution');
	const uTexture = gl.getUniformLocation(program, 'u_texture');
	gl.clearColor(0.0, 0.0, 0.0, 1.0);

	// ON RESIZE
	sCanvas.width = 1024;
	sCanvas.height = 768;
	sTmpCanvas.width = 1024;
	sTmpCanvas.height = lineHeight;
	gl.uniform2f(uResolution, sCanvas.width, sCanvas.height);
	gl.viewport(0, 0, sCanvas.width, sCanvas.height);
	// END RESIZE

	function purgeTextures(arr) {
		for(let i = 0; i < arr.length; i++) {
			const o = arr[i];
			if (o[1]) {
				texturesToPurge.push(o[1]);
			}
		}
	}

	function wrapText(str) {
		if (str.length <= charsPerLine) {
			return [[str, null]];
		}
		let res = [];
		for (let i = 0; i < str.length; i += charsPerLine) {
			res.push([str.substr(i, charsPerLine), null]);
		}
		return res.reverse();
	}

	function recomputeLines() {
		let newCliScreenView = [];
		for (let i = cliText.length - 1; i >= 0; i--) {
			const data = wrapText(content[i]);
			newCliScreenView = newCliScreenView.concat(data);
			if (newCliScreenView.length >= lineCount) {
				break;
			}
		}
		cliScreenView = newCliScreenView.reverse();
		if (cliScreenView.length > lineCount) {
			purgeTextures(cliScreenView.splice(0, cliScreenView.length - lineCount));
		}
	}

	// TODO: DYNAMIC
	function resize(_lineCount, _charsPerLine) {
		cliScreenView.clear();
		recomputeLines();
		lineCount = _lineCount;
		charsPerLine = _charsPerLine;
	}

	const texPosBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, texPosBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		0, 0,
		1, 0,
		0, 1,
		1, 1
	]), gl.STATIC_DRAW);
	gl.vertexAttribPointer(
        aTexPosition,
        2,
        gl.FLOAT,
        false,
        0,
		0);
	gl.enableVertexAttribArray(aTexPosition);

	const posBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
	gl.vertexAttribPointer(
        aPosition,
        2,
        gl.FLOAT,
        false,
        0,
        0);
	gl.enableVertexAttribArray(aPosition);

	function renderTextToTexture(text) {
		sTmpCanvasCtx.fillStyle = '#000000';
		sTmpCanvasCtx.fillRect(0, 0, sTmpCanvas.width, sTmpCanvas.height);
		sTmpCanvasCtx.font = '16px white_rabbitregular';
		sTmpCanvasCtx.fillStyle = '#FFFFFF';
		sTmpCanvasCtx.fillText(text, 0, sTmpCanvas.height);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sTmpCanvas);
	}

	const promptTexture = gl.createTexture();
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, promptTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

	function render() {
		renderInProgress = false;
		for (let i = 0; i < texturesToPurge.length; i++) {
			gl.deleteTexture(texturesToPurge[i]);
		}

		const width = gl.canvas.width;

		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(uTexture, 0);
		texturesToPurge = [];

		let prevY = 0;
		for (let i = 0; i < cliScreenView.length; i++) {
			const currentView = cliScreenView[i];
			if (!currentView[1]) {
				currentView[1] = gl.createTexture();
				gl.bindTexture(gl.TEXTURE_2D, currentView[1]);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);	
				renderTextToTexture(currentView[0]);
			} else {
				gl.bindTexture(gl.TEXTURE_2D, currentView[1]);
			}

			let y = totalLineHeight * (i + 1);
			gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([
					0, y - lineHeight,
					width, y - lineHeight,
					0, y,
					width, y
				]),
                gl.STATIC_DRAW);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			prevY = y;
		}

		gl.activeTexture(gl.TEXTURE1);
		gl.uniform1i(uTexture, 1);
		if (canInput) {
			renderTextToTexture(`${user}$ ${typedText}`);
		} else {
			renderTextToTexture('...');
		}
		prevY += lineSpacing;
		gl.bufferData(gl.ARRAY_BUFFER,
			new Float32Array([
				0, prevY,
				width, prevY,
				0, prevY + lineHeight,
				width, prevY + lineHeight
			]),
			gl.STATIC_DRAW);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function queueRender() {
		if (renderInProgress) {
			return;
		}
		renderInProgress = true;
		requestAnimationFrame(render);
	}

	function addContent(content) {
		if (typeof content === 'string') {
			content = [content];
		}
		cliText = cliText.concat(content);
		let addScreenView = [];
		for (let i = content.length - 1; i >= 0; i--) {
			const data = wrapText(content[i]);
			addScreenView = addScreenView.concat(data);
			if (addScreenView.length >= lineCount) {
				break;
			}
		}
		addScreenView = addScreenView.reverse();
		if (addScreenView.length < lineCount) {
			cliScreenView = cliScreenView.concat(addScreenView);
		} else {
			purgeTextures(cliScreenView);
			cliScreenView = addScreenView;
		}
		if (cliScreenView.length > lineCount) {
			purgeTextures(cliScreenView.splice(0, cliScreenView.length - lineCount));
		}
		queueRender();
	}

	function clearContent() {
		cliText = [];
		cliScreenView = [];
		queueRender();
	}

	worker.onmessage = msg => {
		msg = msg.data;
		switch(msg[0]) {
			case 'status':
				sStatus.innerHTML = msg[1];
				document.title = msg[2];
				break;
			case 'user':
				user = msg[1];
				break;
			case 'shell':
				msg.shift();
				addContent(msg);
				break;
			case 'canInput':
				canInput = msg[1];
				queueRender();
				break;
			case 'init':
				worker.postMessage(['init', document.location.host, document.location.protocol]);
				break;
			case 'reload':
				document.location.reload();
				break;
		}
	};

	addContent('Hi');

	document.onkeydown = e => {
		switch (e.key) {
			case 'Enter':
				const t = typedText.trim();
				typedText = '';
				cursorPos = 0;
				const i = t.indexOf(' ');
				let cmd, args;
				if (i >= 0) {
					cmd = t.substr(0, i);
					args = t.substr(i + 1);
				} else {
					cmd = t;
					args = '';
				}
				addContent(`${user}$ ${t}`);
				switch (cmd) {
					case 'user':
						if (args !== '') {
							worker.postMessage(['user',args]);
							break;
						}
						worker.postMessage(['lsuser']);
						break;
					case 'create_user':
						worker.postMessage(['mkuser', args]);
						break;
					case 'retire_user':
						worker.postMessage(['rmuser', args]);
						break;
					case 'clear':
						clearContent();
						break;
					default:
						worker.postMessage(['command',cmd,args]);
						break;
				}
				break;
			case 'Backspace':
				typedText = typedText.substr(0, cursorPos - 1) + typedText.substr(cursorPos);
				cursorPos--;
				break;
			case 'ArrowLeft':
				if (cursorPos > 0) {
					cursorPos--;
				}
				break;
			case 'ArrowRight':
				if (cursorPos < typedText.length) {
					cursorPos++;
				}
				break;
			case 'ArrowUp':
				break;
			case 'ArrowDown':
				break;
			case 'Delete':
				typedText = typedText.substr(0, cursorPos) + typedText.substr(cursorPos + 1);
				break;
			case 'Escape':
				typedText = '';
				cursorPos = 0;
				break;
			default:
				if (e.key && e.key.length === 1) {
					typedText = typedText.substr(0, cursorPos) + e.key + typedText.substr(cursorPos);
					cursorPos++;
				}
				break;
		}
		queueRender();
	};
}