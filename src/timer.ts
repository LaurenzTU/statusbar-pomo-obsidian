import { Notice, moment, TFolder, TFile } from 'obsidian';
import { notificationUrl, whiteNoiseUrl } from './audio_urls';
import { WhiteNoise } from './white_noise';
import PomoTimerPlugin from './main';

const electron = require("electron");

const MILLISECS_IN_MINUTE = 60 * 1000;

export const enum Mode {
	Pomo,
	ShortBreak,
	LongBreak,
	NoTimer
}


export class Timer {
	plugin: PomoTimerPlugin;
	startTime: moment.Moment; /*when currently running timer started*/
	endTime: moment.Moment;   /*when currently running timer will end if not paused*/
	mode: Mode;
	pausedTime: number;  /*time left on paused timer, in milliseconds*/
	paused: boolean;
	autoPaused: boolean;
	pomosSinceStart: number;
	cyclesSinceLastAutoStop: number;
	activeNote: TFile;
	whiteNoisePlayer: WhiteNoise;
	/** Start time of the current pomodoro session across pauses */
	pomoSessionStartTime: moment.Moment | null;
	/** Start time of the current break session across pauses */
	breakSessionStartTime: moment.Moment | null;

	constructor(plugin: PomoTimerPlugin) {
		this.plugin = plugin;
		this.mode = Mode.NoTimer;
		this.paused = false;
		this.pomosSinceStart = 0;
		this.cyclesSinceLastAutoStop = 0;

			if (this.plugin.settings.whiteNoise === true) {
				this.whiteNoisePlayer = new WhiteNoise(plugin, whiteNoiseUrl);
			}

			this.pomoSessionStartTime = null;
			this.breakSessionStartTime = null;
		}

	onRibbonIconClick() {
		if (this.mode === Mode.NoTimer) {  //if starting from not having a timer running/paused
			this.startTimer(Mode.Pomo);
		} else { //if timer exists, pause or unpause
			this.togglePause();
		}
	}

	/*Set status bar to remaining time or empty string if no timer is running*/
	//handling switching logic here, should spin out
	async setStatusBarText(): Promise<string> {
		if (this.mode !== Mode.NoTimer) {
			let timer_type_symbol = "";
			if (this.plugin.settings.emoji === true) {
				timer_type_symbol = "🏖️ ";
				if (this.mode === Mode.Pomo) {
					timer_type_symbol = "🍅 ";
				}
			}

			if (this.paused === true) {
				return timer_type_symbol + millisecsToString(this.pausedTime); //just show the paused time
			} else if (moment().isSameOrAfter(this.endTime)) {
				await this.handleTimerEnd();
			}

			return timer_type_symbol + millisecsToString(this.getCountdown()); //return display value
		} else {
			return ""; //fixes TypeError: failed to execute 'appendChild' on 'Node https://github.com/kzhovn/statusbar-pomo-obsidian/issues/4
		}
	}

	async handleTimerEnd() {
		if (this.mode === Mode.Pomo) { //completed another pomo
			this.pomosSinceStart += 1;

			if (this.plugin.settings.logging === true) {
				await this.logPomo();
				await this.updateDailySummary();
			}
		} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
			this.cyclesSinceLastAutoStop += 1;

			if (this.plugin.settings.logging === true) {
				await this.logBreak();
				await this.updateDailySummary();
			}
		}

		//switch mode
		if (this.plugin.settings.notificationSound === true) { //play sound end of timer
			playNotification();
		}
		if (this.plugin.settings.useSystemNotification === true) { //show system notification end of timer
			showSystemNotification(this.mode, this.plugin.settings.emoji);
		}

		if (this.plugin.settings.autostartTimer === false && this.plugin.settings.numAutoCycles <= this.cyclesSinceLastAutoStop) { //if autostart disabled, pause and allow user to start manually
			this.setupTimer();
			this.autoPaused = true;
			this.paused = true;
			this.pausedTime = this.getTotalModeMillisecs();
			this.cyclesSinceLastAutoStop = 0;
		} else {
			this.startTimer();
		}
	}

	async quitTimer(): Promise<void> {
		// If quitting a running pomodoro early, note it in the log
		if (this.plugin.settings.logging === true && this.mode === Mode.Pomo) {
			try {
				if (!this.endTime || moment().isBefore(this.endTime)) {
					await this.logPomoQuitEarly();
					await this.updateDailySummary();
				}
			} catch (e) {
				console.log(e);
			}
		}

		this.mode = Mode.NoTimer;
		this.startTime = moment(0);
		this.endTime = moment(0);
		this.paused = false;
		this.pomosSinceStart = 0;

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}

		await this.plugin.loadSettings(); //why am I loading settings on quit? to ensure that when I restart everything is correct? seems weird
	}

	pauseTimer(): void {
		this.paused = true;
		this.pausedTime = this.getCountdown();

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}
	}

	async togglePause() {
		if (this.paused === true) {
			this.restartTimer();
		} else if (this.mode !== Mode.NoTimer) { //if some timer running
			this.pauseTimer();
			new Notice("Timer paused.")
		}

		// Update summary on any state change
		if (this.plugin.settings.logging === true) {
			await this.updateDailySummary();
		}
	}

		restartTimer(): void {
		if (this.plugin.settings.logActiveNote === true && this.autoPaused === true) {
			this.setLogFile();
			this.autoPaused = false;
		}

		this.setStartAndEndTime(this.pausedTime);
		this.modeRestartingNotification();
		this.paused = false;

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
	}

	startTimer(mode: Mode = null): void {
		this.setupTimer(mode);
		this.paused = false; //do I need this?


		// Capture the active note at start so it can be logged later
		this.setLogFile();

		// Log immediately when a session starts
		if (this.plugin.settings.logging === true) {
			if (this.mode === Mode.Pomo) {
				this.logPomoStart();
			} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
				this.logBreakStart();
			}
			this.updateDailySummary();
		}

		this.modeStartingNotification();

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
	}

	private setupTimer(mode: Mode = null) {
		if (mode === null) { //no arg -> start next mode in cycle
			if (this.mode === Mode.Pomo) {
				if (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) {
					this.mode = Mode.LongBreak;
				} else {
					this.mode = Mode.ShortBreak;
				}
			} else { //short break, long break, or no timer
				this.mode = Mode.Pomo;
			}
		} else { //starting a specific mode passed to func
			this.mode = mode;
		}

		// When entering a new session, record the session start time
		if (this.mode === Mode.Pomo) {
			this.pomoSessionStartTime = moment();
			this.breakSessionStartTime = null;
		} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
			this.breakSessionStartTime = moment();
			this.pomoSessionStartTime = null;
		}
		this.setStartAndEndTime(this.getTotalModeMillisecs());
	}

	setStartAndEndTime(millisecsLeft: number): void {
		this.startTime = moment(); //start time to current time
		this.endTime = moment().add(millisecsLeft, 'milliseconds');
	}

	/*Return milliseconds left until end of timer*/
	getCountdown(): number {
		let endTimeClone = this.endTime.clone(); //rewrite with freeze?
		return endTimeClone.diff(moment());
	}

	getTotalModeMillisecs(): number {

		switch (this.mode) {
			case Mode.Pomo: {
				return this.plugin.settings.pomo * MILLISECS_IN_MINUTE;
			}
			case Mode.ShortBreak: {
				return this.plugin.settings.shortBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.LongBreak: {
				return this.plugin.settings.longBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.NoTimer: {
				throw new Error("Mode NoTimer does not have an associated time value");
			}
		}
	}



	/**************  Notifications  **************/
	/*Sends notification corresponding to whatever the mode is at the moment it's called*/
	modeStartingNotification(): void {
		let time = this.getTotalModeMillisecs();
		let unit: string;

		if (time >= MILLISECS_IN_MINUTE) { /*display in minutes*/
			time = Math.floor(time / MILLISECS_IN_MINUTE);
			unit = 'minute';
		} else { /*less than a minute, display in seconds*/
			time = Math.floor(time / 1000); //convert to secs
			unit = 'second';
		}

		switch (this.mode) {
			case (Mode.Pomo): {
				new Notice(`Starting ${time} ${unit} pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Starting ${time} ${unit} break.`);
				break;
			}
			case (Mode.NoTimer): {
				new Notice('Quitting pomodoro timer.');
				break;
			}
		}
	}

	modeRestartingNotification(): void {
		switch (this.mode) {
			case (Mode.Pomo): {
				new Notice(`Restarting pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Restarting break.`);
				break;
			}
		}
	}



	/**************  Logging  **************/
	private buildLogText(prefix: string = "", durationMs?: number): string {
		// Always log only the time of day (no date)
		let timestamp = moment().format('HH:mm');
		let logText = prefix ? `${prefix} ${timestamp}` : timestamp;

		// Append duration before the note link when provided
		if (typeof durationMs === 'number' && !isNaN(durationMs) && durationMs >= 0) {
			logText = `${logText} — ${millisecsToString(durationMs)}`;
		}

		// Always place the active note link at the end when enabled
		if (this.plugin.settings.logActiveNote === true && this.activeNote) {
			const linkText = this.plugin.app.fileManager.generateMarkdownLink(this.activeNote, '');
			logText = `${logText} ${linkText}`;
			logText = logText.replace(String.raw`\n`, "\n");
		}

		return logText;
	}

	private async writeLogEntry(logText: string): Promise<void> {
		const filePath = await this.getOrCreateLogFilePath();
		await this.insertUnderDailyHeading(filePath, logText);
	}

	async logPomo(): Promise<void> {
		let durationMs = this.pomoSessionStartTime ? moment().diff(this.pomoSessionStartTime) : (this.plugin.settings.pomo * MILLISECS_IN_MINUTE);
		const logText = this.buildLogText("[🍅]", durationMs);
		await this.writeLogEntry(logText);
		this.pomoSessionStartTime = null;
	}

	async logPomoStart(): Promise<void> {
		const logText = this.buildLogText("[🍅 Start]");
		await this.writeLogEntry(logText);
	}

	async logPomoQuitEarly(): Promise<void> {
		let baseStart = this.pomoSessionStartTime || this.startTime;
		let durationMs = baseStart ? moment().diff(baseStart) : undefined;
		const logText = this.buildLogText("[🍅 Quit Early]", durationMs);
		await this.writeLogEntry(logText);
		this.pomoSessionStartTime = null;
	}

	async logBreakStart(): Promise<void> {
		const logText = this.buildLogText("[🏖 Start]");
		await this.writeLogEntry(logText);
	}

	async logBreak(): Promise<void> {
		let durationMs = this.breakSessionStartTime ? moment().diff(this.breakSessionStartTime) : undefined;
		const logText = this.buildLogText("[🏖]", durationMs);
		await this.writeLogEntry(logText);
		this.breakSessionStartTime = null;
	}

	//from Note Refactor plugin by James Lynch, https://github.com/lynchjames/note-refactor-obsidian/blob/80c1a23a1352b5d22c70f1b1d915b4e0a1b2b33f/src/obsidian-file.ts#L69
	async appendFile(filePath: string, logText: string): Promise<void> {
		let existingContent = await this.plugin.app.vault.adapter.read(filePath);
		if (existingContent.length > 0) {
			existingContent = existingContent + '\r';
		}
		await this.plugin.app.vault.adapter.write(filePath, existingContent + logText);
	}

	private async getOrCreateLogFilePath(): Promise<string> {
		if (this.plugin.settings.logToDaily === true) {
			return (await this.plugin.getDailyNoteFile()).path;
		}

		let file = this.plugin.app.vault.getAbstractFileByPath(this.plugin.settings.logFile);
		if (!file || file !instanceof TFolder) { // if no file, create
			console.log("Creating pomodoro log file");
			await this.plugin.app.vault.create(this.plugin.settings.logFile, "");
		}
		return this.plugin.settings.logFile;
	}

	private getTodayHeadingPrefix(): string {
		// One heading per day, include weekday name, totals appended later
		const todayStr = moment().format('YYYY-MM-DD (dddd)');
		return `## ${todayStr}`;
	}

	private buildHeadingWithTotals(pomoMs: number, breakMs: number): string {
		const totalMs = pomoMs + breakMs;
		return `${this.getTodayHeadingPrefix()} — 🍅 ${this.formatTotal(pomoMs)}, 🏖 ${this.formatTotal(breakMs)}, Σ ${this.formatTotal(totalMs)}`;
	}

	private findSectionBounds(lines: string[], headingPrefix: string): { start: number, end: number } | null {
		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith(headingPrefix)) {
				start = i;
				break;
			}
		}
		if (start === -1) return null;
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (lines[i].startsWith('## ') || lines[i].startsWith('# ')) {
				end = i;
				break;
			}
		}
		return { start, end };
	}

	private async insertUnderDailyHeading(filePath: string, logText: string): Promise<void> {
		let content = await this.plugin.app.vault.adapter.read(filePath);
		const headingPrefix = this.getTodayHeadingPrefix();
		let lines = content.split(/\r?\n/);

		let section = this.findSectionBounds(lines, headingPrefix);
		if (!section) {
			// Create new heading at end
			const pomoMs = 0;
			const breakMs = 0;
			const headingLine = this.buildHeadingWithTotals(pomoMs, breakMs);
			if (content.length > 0 && !content.endsWith('\n')) content += '\n';
			content += headingLine + '\n';
			content += logText;
			await this.plugin.app.vault.adapter.write(filePath, content);
			return;
		}

		// Insert logText at the end of the section
		const insertIndex = section.end; // before next heading or at EOF
		const needsNewlineBefore = insertIndex > 0 && lines[insertIndex - 1].length > 0;
		if (needsNewlineBefore) {
			lines.splice(insertIndex, 0, '');
			section.end++;
		}
		lines.splice(section.end, 0, logText);

		await this.plugin.app.vault.adapter.write(filePath, lines.join('\n'));
	}

	setLogFile(){
		const activeView = this.plugin.app.workspace.getActiveFile();
		if (activeView) {
			this.activeNote = activeView;
		}
	}

	/**************  Daily Summary (daily notes) **************/
	private parseDurationToMillis(duration: string): number {
		// duration formats: HH:mm:ss or mm:ss
		const parts = duration.split(":").map(p => Number(p));
		if (parts.length === 3) {
			return ((parts[0] * 60 * 60) + (parts[1] * 60) + parts[2]) * 1000;
		} else if (parts.length === 2) {
			return ((parts[0] * 60) + parts[1]) * 1000;
		}
		return 0;
	}

	private sumDurations(content: string, type: 'pomo' | 'break'): number {
		const lines = content.split(/\r?\n/);
		let sum = 0;
		for (const line of lines) {
			const trimmed = line.trim();
			let isMatch = false;
			if (type === 'pomo') {
				// Include completed pomos and quit-early pomos, exclude starts
				isMatch = (trimmed.startsWith('[🍅]') || trimmed.startsWith('[🍅 Quit Early]')) && !trimmed.includes('Start');
			} else {
				// Include completed breaks, exclude starts
				isMatch = trimmed.startsWith('[🏖]') && !trimmed.includes('Start');
			}
			if (!isMatch) continue;

			const m = trimmed.match(/—\s+([0-9]{1,2}:\d{2}(?::\d{2})?)/);
			if (m && m[1]) {
				sum += this.parseDurationToMillis(m[1]);
			}
		}
		return sum;
	}

	private formatTotal(ms: number): string {
		return millisecsToString(ms);
	}

	private async updateDailySummary(): Promise<void> {
		if (this.plugin.settings.logging !== true) return;

		const filePath = await this.getOrCreateLogFilePath();
		let content = await this.plugin.app.vault.adapter.read(filePath);
		let lines = content.split(/\r?\n/);

		const headingPrefix = this.getTodayHeadingPrefix();
		let section = this.findSectionBounds(lines, headingPrefix);
		if (!section) {
			// Nothing to update if today's heading doesn't exist yet
			return;
		}

		// Compute totals within the section (excluding the heading line)
		const sectionLines = lines.slice(section.start + 1, section.end);
		const sectionContent = sectionLines.join('\n');
		const pomoMs = this.sumDurations(sectionContent, 'pomo');
		const breakMs = this.sumDurations(sectionContent, 'break');

		lines[section.start] = this.buildHeadingWithTotals(pomoMs, breakMs);
		await this.plugin.app.vault.adapter.write(filePath, lines.join('\n'));
	}
}

/*Returns [HH:]mm:ss left on the current timer*/
function millisecsToString(millisecs: number): string {
	let formattedCountDown: string;

	if (millisecs >= 60 * 60 * 1000) { /* >= 1 hour*/
		formattedCountDown = moment.utc(millisecs).format('HH:mm:ss');
	} else {
		formattedCountDown = moment.utc(millisecs).format('mm:ss');
	}

	return formattedCountDown.toString();
}

function playNotification(): void {
	const audio = new Audio(notificationUrl);
	audio.play();
}

function showSystemNotification(mode:Mode, useEmoji:boolean): void {
	let text = "";
	switch (mode) {
		case (Mode.Pomo): {
			let emoji = useEmoji ? "🏖" : ""
			text = `End of the pomodoro, time to take a break ${emoji}`;
			break;
		}
		case (Mode.ShortBreak):
		case (Mode.LongBreak): {
			let emoji = useEmoji ? "🍅" : ""
			text = `End of the break, time for the next pomodoro ${emoji}`;
			break;
		}
		case (Mode.NoTimer): {
			// no system notification needed
			return;
		}
	}
	let emoji = useEmoji ? "🍅" : ""
	let title = `Obsidian Pomodoro ${emoji}`;

	// Show system notification
	const Notification = (electron as any).remote.Notification;
	const n = new Notification({
		title: title,
		body: text,
		silent: true
	});
	n.on("click", () => {
		n.close();
	});
	n.show();
}
