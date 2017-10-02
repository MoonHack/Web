'use strict';

function initialize() {
	const sCanvas = document.getElementById('shellCanvas');
	const gl = sCanvas.getContext('webgl');
	const sStatus = document.getElementById('statusContainer');

	const sTmpCanvas = document.getElementById('textTempCanvas');
	const sTmpCanvasCtx = sTmpCanvas.getContext('2d');

	const worker = new Worker('static/worker.js');

	let user = '', canInput = false;

	const dpiScalingFactor = 1;

	const lineHeight = 16 * dpiScalingFactor;
	const lineSpacing = 0 * dpiScalingFactor;
	const charWidth = 9 * dpiScalingFactor;
	const totalLineHeight = lineHeight + lineSpacing;

	let lineCount;
	let charsPerLine;

	let commandHistoryPos = 0;
	let commandHistory = [];

	let cursorPos = 0;
	let typedText = '';
	let cliText = [];
	let cliTextSplit = [];
	let lineBuffer = [];
	let renderQueued = false;
	let cliTextSplitDirty = true;
	let cliScrollOffset = 0;

	let texturesToPurge = [];

	const program = webglUtils.createProgramFromScripts(gl, ['2d-vertex-shader','2d-fragment-shader']);
	gl.useProgram(program);
	const aPosition = gl.getAttribLocation(program, 'a_position');
	const aTexPosition = gl.getAttribLocation(program, 'a_tex_position');
	const uResolution = gl.getUniformLocation(program, 'u_resolution');
	const uTexture = gl.getUniformLocation(program, 'u_texture');
	const uFixedColor = gl.getUniformLocation(program, 'u_fixedcolor');
	gl.clearColor(0.0, 0.0, 0.0, 1.0);

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
		return res;
	}

	function recomputeView() {
		cliTextSplitDirty = true;
	}

	function recomputeLines() {
		let newCliScreenView = [];
		for (let i = 0; i < cliText.length; i++) {
			const data = wrapText(cliText[i]);
			newCliScreenView = newCliScreenView.concat(data);
		}
		purgeTextures(cliTextSplit);
		cliTextSplit = newCliScreenView;
		recomputeView();
	}

	// TODO: DYNAMIC
	function resize(width, height) {
		sCanvas.width = width;
		sCanvas.height = height;
		sTmpCanvas.width = width;
		sTmpCanvas.height = lineHeight;
		gl.uniform2f(uResolution, sCanvas.width, sCanvas.height);
		gl.viewport(0, 0, sCanvas.width, sCanvas.height);
		lineCount = Math.floor(height / totalLineHeight) - 2; // Reserve 2 line for prompt
		charsPerLine = Math.floor(width / charWidth);
		recomputeLines();
		worker.postMessage(['resize', charsPerLine, lineCount]);
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
		sTmpCanvasCtx.fillStyle = '#00FF00';
		sTmpCanvasCtx.textBaseline = 'top';
		sTmpCanvasCtx.fillText(text, 0, 0);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sTmpCanvas);
	}

	const promptTexture = gl.createTexture();
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, promptTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

	function drawCursor() {
		gl.activeTexture(gl.TEXTURE2);
	
		let y = totalLineHeight * Math.min(cliTextSplit.length, lineCount) + totalLineHeight;
		let x = charWidth * (cursorPos + 2 + user.length) + 1;
		let height = lineHeight / 2;
		let width = charWidth;

		let phase = Math.floor(Date.now() / 250);
		let cPhase = phase % 16 > 7 ? 0 : 1;
		let cPhaseInv = cPhase ? 0 : 1;

		if (!canInput) {
			gl.uniform4f(uFixedColor, cPhase, cPhaseInv, 0, 1.0);
		} else {
			gl.uniform4f(uFixedColor, 0, cPhaseInv, 0, 1.0);
		}
		gl.bufferData(gl.ARRAY_BUFFER,
			new Float32Array([
				x, y,
				x + width, y,
				x, y + height,
				x + width, y + height
			]),
			gl.STATIC_DRAW);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		if (!canInput) {
			gl.uniform4f(uFixedColor, cPhaseInv, cPhase, 0, 1.0);

			width /= 2
			switch (phase % 2) {
				case 0:
					break;
				case 1:
					x += width;
					break;
			}
			gl.bufferData(gl.ARRAY_BUFFER,
				new Float32Array([
					x, y,
					x + width, y,
					x, y + height,
					x + width, y + height
				]),
				gl.STATIC_DRAW);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}

		gl.uniform4f(uFixedColor, 0.0, 0.0, 0.0, 0.0);
	}

	function render() {
		renderQueued = false;

		for (let i = 0; i < texturesToPurge.length; i++) {
			gl.deleteTexture(texturesToPurge[i]);
		}
		texturesToPurge = [];

		const width = gl.canvas.width;

		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(uTexture, 0);

		const renderLineStart = cliTextSplit.length - (cliScrollOffset + lineCount);
		const renderLineEnd = renderLineStart + lineCount;

		if (cliTextSplitDirty) {
			for (let i = 0; i < renderLineStart; i++) {
				const t = cliTextSplit[i][1];
				if (t) {
					cliTextSplit[i][1] = null;
					gl.deleteTexture(t);
				}
			}

			for (let i = renderLineEnd; i < cliTextSplit.length; i++) {
				const t = cliTextSplit[i][1];
				if (t) {
					cliTextSplit[i][1] = null;
					gl.deleteTexture(t);
				}
			}
			cliTextSplitDirty = false;
		}

		let prevY = 0;
		for (let i = renderLineStart; i < renderLineEnd; i++) {
			const currentView = cliTextSplit[i];
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

			let y = totalLineHeight + prevY;
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
		renderTextToTexture(`${user}$ ${typedText}`);
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

		drawCursor();
	}

	function queueRender() {
		if (renderQueued) {
			return;
		}
		renderQueued = true;
		requestAnimationFrame(render);
	}

	setInterval(queueRender, 250);

	function addContent(content) {
		if (typeof content === 'string') {
			content = [content];
		}
		cliText = cliText.concat(content);
		for (let i = content.length - 1; i >= 0; i--) {
			const data = wrapText(content[i]);
			cliTextSplit = cliTextSplit.concat(data);
		}
		recomputeView();
		queueRender();
	}

	for (let i = 0; i < 100; i++) {
		addContent([`LINE ${i}`,'b']);
	}

	function clearContent() {
		cliText = [];
		purgeTextures(cliTextSplit);
		cliTextSplit = [];
		cliTextSplitDirty = true;
		cliScrollOffset = 0;
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



	function onmousewheel(e) {
		if (e.deltaY < 0) {
			if (cliScrollOffset < cliTextSplit.length - lineCount) {
				cliScrollOffset++;
			} else {
				return;
			}
		} else if (e.deltaY > 0) {
			if (cliScrollOffset > 0) {
				cliScrollOffset--;
			} else {
				return;
			}
		} else {
			return;
		}
		e.preventDefault();
		queueRender();
	}

	document.addEventListener('DOMMouseScroll',onmousewheel);
	document.addEventListener('mousewheel', onmousewheel);
	document.addEventListener('wheel', onmousewheel);

	document.addEventListener('keydown', e => {
		switch (e.key) {
			case 'Enter':
				if (!canInput) {
					return;
				}
				const t = typedText.trim();
				commandHistory.push(t);
				while (commandHistory.length > 100) {
					commandHistory.shift();	
				}
				commandHistoryPos = commandHistory.length;
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
				if (cursorPos > 0) {
					typedText = typedText.substr(0, cursorPos - 1) + typedText.substr(cursorPos);
					cursorPos--;
				}
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
				if (commandHistoryPos > 0) {
					--commandHistoryPos;
				}
				typedText = commandHistory[commandHistoryPos];
				break;
			case 'ArrowDown':
				if (commandHistoryPos < commandHistory.length - 1) {
					++commandHistoryPos;
				} else if (commandHistoryPos >= commandHistory.length) {
					commandHistoryPos = commandHistory.length - 1;
				}
				typedText = commandHistory[commandHistoryPos];
				break;
			case 'PageUp':
				if (cliScrollOffset < cliTextSplit.length - lineCount) {
					cliScrollOffset++;
				}
				break;
			case 'PageDown':
				if (cliScrollOffset > 0) {
					cliScrollOffset--;
				}
				break;
			case 'Delete':
				typedText = typedText.substr(0, cursorPos) + typedText.substr(cursorPos + 1);
				break;
			case 'Escape':
				typedText = '';
				cursorPos = 0;
				commandHistoryPos = commandHistory.length;
				break;
			default:
				if (e.key && e.key.length === 1) {
					typedText = typedText.substr(0, cursorPos) + e.key + typedText.substr(cursorPos);
					cursorPos++;
				} else {
					return;
				}
				break;
		}
		e.preventDefault();
		queueRender();
	});

	resize(1024, 768);
}