import fs from "fs";
import { JWT } from "google-auth-library";
import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet } from "google-spreadsheet";
import FrameworkClient from "strike-discord-framework";
import Logger from "strike-discord-framework/dist/logger.js";

const SHEET_ID = "12Fr3aL16m1-uuL3e1R_z4ErUH2lc8dktgpePyUloQHs";

export interface OpMember {
	uniqueName: string;
	displayName: string;
	callsign: string;
	type: string;
	bolters: string;
	wire: string;
	lsoGrade: string;
	combatDeaths: string;
	promotions: string;
	remarks: string;
}

export interface OpConfig {
	countBolters: boolean;
	countDeaths: boolean;
}

export interface IOp {
	name: string;
	timeslot: string;
	members: OpMember[];
	config: OpConfig;
	id: string;
}

const columNameMap = {
	uniqueName: "Name",
	callsign: "Callsign",
	type: "Type",
	bolters: "Bolters",
	wire: "Wire No.",
	lsoGrade: "LSO Grade",
	combatDeaths: "Combat Deaths",
	promotions: "Promotions",
	remarks: "Remarks"
} as Record<keyof OpMember, string>;

type ColumnMap = Record<keyof OpMember, number>;

const defaultConfig: OpConfig = { countBolters: true, countDeaths: true };

enum Change {
	NoChange,
	Passed,
	Failed
}

function parseEvent(value: string, ignoreBecauseOfConfig: boolean): Change {
	if (ignoreBecauseOfConfig) return Change.NoChange;
	const num = parseInt(value);
	if (value === undefined || value === null || value === "" || isNaN(num)) return Change.NoChange;
	if (num > 0) return Change.Failed;
	return Change.Passed;
}

class Op {
	public name: string;
	public members: OpMember[] = [];

	private constructor(public sheet: GoogleSpreadsheetWorksheet, public timeslot: string, public config: OpConfig, private startRow: number) {}

	public static fromSheet(sheet: GoogleSpreadsheetWorksheet) {
		console.log(`Loading op ${sheet.title}`);

		const ops: Op[] = [];
		const opConfig = this.getOpConfig(sheet);

		for (let row = 0; row < sheet.rowCount; row++) {
			const cell = sheet.getCell(row, 0);
			if (cell.value == "Name") {
				// Get timeslot in cell directly above
				const timeSlot = sheet.getCell(row - 1, 0).value as string;
				const newOp = new Op(sheet, timeSlot, opConfig, row);
				newOp.load();
				ops.push(newOp);
			}
		}

		return ops;
	}

	public load() {
		this.name = `${this.sheet.title} ${this.timeslot}`;
		const columnMap = this.loadColumnMap(this.startRow);
		for (let row = this.startRow + 1; row < this.sheet.rowCount; row++) {
			if (row + 2 < this.sheet.rowCount) {
				const cell = this.sheet.getCell(row + 2, 0);
				if (cell && cell.value == "Name") break;
			}

			const member = this.parseOpMemberRow(row, columnMap);
			this.members.push(member);
		}
	}

	public hasMember(name: string) {
		return this.members.some(member => member.uniqueName == name);
	}

	public getMember(name: string) {
		return this.members.find(member => member.uniqueName == name);
	}

	private parseOpMemberRow(row: number, mapping: ColumnMap): OpMember {
		const member = {} as OpMember;
		Object.keys(mapping).forEach(key => {
			const column = mapping[key];
			const cell = this.sheet.getCell(row, column);
			member[key] = cell.value as string;
		});

		if (member.uniqueName) {
			member.displayName = member.uniqueName;
			member.uniqueName = member.uniqueName.toLowerCase();
		}

		return member;
	}

	private loadColumnMap(row: number) {
		const columnMap = {} as ColumnMap;

		Object.keys(columNameMap).forEach(key => {
			for (let column = 0; column < this.sheet.columnCount; column++) {
				const cell = this.sheet.getCell(row, column);
				// console.log(columNameMap[key], cell.value);
				if (cell.value && cell.value.toString().trim() == columNameMap[key]) {
					columnMap[key] = column;
					return;
				}
			}

			console.log(`Unable to find column for ${key}`);
		});

		return columnMap;
	}

	private static getOpConfig(sheet: GoogleSpreadsheetWorksheet) {
		const config = { ...defaultConfig };
		let configRow = -1;
		let configColumn = -1;
		for (let row = 0; row < sheet.rowCount; row++) {
			for (let column = 0; column < sheet.columnCount; column++) {
				const cell = sheet.getCell(row, column);
				if (cell.value && cell.value.toString().toLowerCase() == "config") {
					configRow = row;
					configColumn = column;
					break;
				}
			}
			if (configRow != -1) break;
		}

		if (configRow == -1) return config;

		for (let row = configRow + 1; row < sheet.rowCount; row++) {
			const cell = sheet.getCell(row, configColumn);
			if (!cell.value) continue;
			const cellVal = cell.value.toString().toLowerCase();
			if (cellVal == "count bolters") config.countBolters = sheet.getCell(row, configColumn + 1).value as boolean;
			if (cellVal == "count deaths") config.countDeaths = sheet.getCell(row, configColumn + 1).value as boolean;
		}

		return config;
	}
}

interface SheetParseResult {
	members: Record<string, OverallMember>;
	achievementHistory: string;
	opAchievementLog: string;
}

interface OverallMember {
	history: string;
	fiveOpsWithoutDeath: number;
	fiveOpsWithoutBolter: number;
}
class GoogleSheetParser {
	private log: Logger;
	private doc: GoogleSpreadsheet;

	// private memberHistory: Record<string, string> = {};
	private members: Record<string, OverallMember> = {};
	private achievementHistory = "";

	private opAchievementLog: Record<string, string> = {};

	constructor(private sheetId: string, private framework: FrameworkClient) {
		this.log = framework.log;
	}

	private loadCreds() {
		const creds = JSON.parse(fs.readFileSync("../caw8-creds.json", "utf8"));

		const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"];

		const jwt = new JWT({
			email: creds.client_email,
			key: creds.private_key,
			scopes: SCOPES
		});

		return jwt;
	}

	async init() {
		const jwt = this.loadCreds();
		this.doc = new GoogleSpreadsheet(this.sheetId, jwt);
		await this.doc.loadInfo(); // loads document properties and worksheets
		this.log.info(`Loaded document: ${this.doc.title}`);
	}

	public async run(): Promise<SheetParseResult> {
		const ops: Op[] = [];
		const nonOpSheets = ["Operations Record", "Awards Record"];
		for (const sheet of this.doc.sheetsByIndex) {
			await sheet.loadCells();
			if (!sheet.hidden && !nonOpSheets.includes(sheet.title)) {
				const newOps = Op.fromSheet(sheet);
				ops.push(...newOps);
			}
		}

		const members: Set<string> = new Set();
		ops.forEach(op => {
			op.members.forEach(member => members.add(member.uniqueName));
			this.opAchievementLog[op.name] = `------ ${op.name} ------\n`;
		});

		members.forEach(member => {
			this.parseMember(member, ops);
		});

		ops.forEach(op => {
			op.members = op.members.filter(m => m.uniqueName != null);
			delete op.sheet;
		});
		fs.writeFileSync("../ops.json", JSON.stringify(ops, null, 2));
		return;
		// console.log(ops);

		this.log.info("Done parsing!");

		let fullOpAchievementLog = "";
		Object.keys(this.opAchievementLog).forEach(opName => {
			fullOpAchievementLog += this.opAchievementLog[opName];
		});

		return {
			members: this.members,
			achievementHistory: this.achievementHistory,
			opAchievementLog: fullOpAchievementLog
		};
	}

	private parseMember(memberName: string, ops: Op[]) {
		this.members[memberName] = {
			fiveOpsWithoutBolter: 0,
			fiveOpsWithoutDeath: 0,
			history: ""
		};

		const log = (message: string) => (this.members[memberName].history += message + "\n");

		let opsWithoutDeath = 0;
		let opsWithoutBolter = 0;

		ops.forEach(op => {
			const member = op.getMember(memberName);
			const opName = `${op.name}`;
			if (!member) return;

			let deathLog = "";
			const deathResult = parseEvent(member.combatDeaths, !op.config.countDeaths);
			if (deathResult == Change.Failed) {
				opsWithoutDeath = 0;
				deathLog = `Died ${member.combatDeaths} times`;
			} else if (deathResult == Change.Passed) {
				opsWithoutDeath++;
				deathLog = `Did not die (${member.combatDeaths})`;
			} else {
				deathLog = `No logged death (${member.combatDeaths})`;
			}

			let bolterLog = "";
			const bolterResult = parseEvent(member.bolters, !op.config.countBolters);
			if (bolterResult == Change.Failed) {
				opsWithoutBolter = 0;
				bolterLog = `Boltered ${member.bolters} times`;
			} else if (bolterResult == Change.Passed) {
				opsWithoutBolter++;
				bolterLog = `Did not bolter (${member.bolters})`;
			} else {
				bolterLog = `No trap (${member.bolters})`;
			}

			let achievements = "";
			if (opsWithoutDeath >= 5) {
				this.achievementHistory += `After ${opName}, ${member.displayName} has not died in 5 ops!\n`;
				opsWithoutDeath = 0;
				achievements += "[FIVE OPS WITHOUT DEATH] ";
				this.members[memberName].fiveOpsWithoutBolter++;

				this.opAchievementLog[
					op.name
				] += `[FIVE OPS WITHOUT DEATH] ${member.displayName}. They now have this award ${this.members[memberName].fiveOpsWithoutBolter} times\n`;
			}

			if (opsWithoutBolter >= 5) {
				this.achievementHistory += `After ${opName}, ${member.displayName} has not boltered in 5 ops!\n`;
				opsWithoutBolter = 0;
				achievements += "[FIVE OPS WITHOUT BOLTER]";
				this.members[memberName].fiveOpsWithoutDeath++;

				this.opAchievementLog[
					op.name
				] += `[FIVE OPS WITHOUT BOLTER] ${member.displayName}. They now have this award ${this.members[memberName].fiveOpsWithoutDeath} times\n`;
			}

			log(`${opName}: ${deathLog} ${bolterLog} Wire: ${member.wire ?? "N/A"} Remarks: ${member.remarks ?? "N/A"} ${achievements}`);
		});
	}
}

export { GoogleSheetParser, SheetParseResult };
