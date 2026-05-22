import React, { memo, useState } from 'react';
import { Box, Typography, TextField, Button, Alert, Dialog, DialogTitle, DialogContent, DialogActions, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Tab, Tabs } from '@mui/material';

export interface DeviceCardConfig {
    selected?: boolean; // Reserved for selection if needed
    periodSecondsInput: string;
    periodSeconds: number;
    gearInput: string;
    gearValue: number;
    testingState: 'idle' | 'testing' | 'starting' | 'error';
    testType: 'Cycle' | 'Single' | null;
    lastfeedback?: {
        at: number;
        level: 'info' | 'success' | 'warning' | 'error';
        message: string;
    };
}

export type CardAction =
    | { type: 'UPDATE_FIELD'; key: string; field: keyof DeviceCardConfig; value: any }
    | { type: 'SET_TESTING_STATE'; key: string; state: 'idle' | 'testing' | 'starting' | 'error'; testType: 'Cycle' | 'Single' | null }
    | { type: 'ADD_FEEDBACK'; key: string; level: 'info' | 'success' | 'warning' | 'error'; message: string };

export const cardReducer = (state: Record<string, DeviceCardConfig>, action: CardAction): Record<string, DeviceCardConfig> => {
    const { key } = action;
    const current = state[key] || {
        periodSecondsInput: '1',
        periodSeconds: 1,
        gearInput: '0.1',
        gearValue: 1,
        testingState: 'idle',
        testType: null,
    };

    switch (action.type) {
        case 'UPDATE_FIELD':
            return { ...state, [key]: { ...current, [action.field]: action.value } };
        case 'SET_TESTING_STATE':
            return { ...state, [key]: { ...current, testingState: action.state, testType: action.testType } };
        case 'ADD_FEEDBACK':
            return {
                ...state,
                [key]: {
                    ...current,
                    lastfeedback: { at: Date.now(), level: action.level, message: action.message }
                }
            };
        default:
            return state;
    }
};

export interface RawTestData {
    r1?: number;
    r2?: number;
    r3?: number;
    voltage?: number;
    rawR2: number[];
    rawR3: number[];
    parsedR2: number[];
    parsedR3: number[];
    timestamp: string;
}

interface DeviceCardProps {
    connectionId: string;
    deviceKey: string;
    host: string;
    uid: number;
    isOnline: boolean;
    config: DeviceCardConfig;
    dispatch: React.Dispatch<CardAction>;
    onStartF1: (connectionId: string, uid: number, period: number, gear: number) => Promise<boolean>;
    onStopF1: (connectionId: string, uid: number) => Promise<boolean>;
    onStartSingle: (connectionId: string, uid: number, gear: number) => Promise<boolean>;
    statusData?: { dataReady?: boolean; testDone?: boolean }; // 预留给寄存器位显示
    rawTestHistory?: RawTestData[];
}

const DeviceCard: React.FC<DeviceCardProps> = ({
    connectionId, deviceKey, uid, isOnline, config, dispatch, onStartF1, onStopF1, onStartSingle, statusData, rawTestHistory
}) => {
    const [openRawDialog, setOpenRawDialog] = useState(false);
    const [tabValue, setTabValue] = useState(0);
    const [historyIndex, setHistoryIndex] = useState(0);

    const hasHistory = rawTestHistory && rawTestHistory.length > 0;
    // 最新记录在数组末尾（追加的），历史选择器默认展示最新
    const selectedRaw = hasHistory
        ? rawTestHistory[Math.max(0, Math.min(historyIndex, rawTestHistory.length - 1))]
        : undefined;
    const historyCount = rawTestHistory?.length || 0;
    const c = config || {
        periodSecondsInput: '1', periodSeconds: 1,
        gearInput: '1.0', gearValue: 10,
        testingState: 'idle', testType: null
    };

    const isTesting = c.testingState === 'testing' || c.testingState === 'starting';

    const handlePeriodChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        dispatch({ type: 'UPDATE_FIELD', key: deviceKey, field: 'periodSecondsInput', value: e.target.value });
    };
    const handlePeriodBlur = () => {
        let val = parseInt(c.periodSecondsInput, 10);
        if (isNaN(val)) val = 1;
        const clamped = Math.max(1, Math.min(60, val));
        dispatch({ type: 'UPDATE_FIELD', key: deviceKey, field: 'periodSecondsInput', value: String(clamped) });
        dispatch({ type: 'UPDATE_FIELD', key: deviceKey, field: 'periodSeconds', value: clamped });
    };

    const handleGearChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        dispatch({ type: 'UPDATE_FIELD', key: deviceKey, field: 'gearInput', value: e.target.value });
    };
    const handleGearBlur = () => {
        let val = parseFloat(c.gearInput);
        if (isNaN(val)) val = 1.0;
        const clamped = Math.max(0.1, Math.min(62.4, val));
        const rounded = Math.round(clamped * 10) / 10;
        dispatch({ type: 'UPDATE_FIELD', key: deviceKey, field: 'gearInput', value: String(rounded) });
        dispatch({ type: 'UPDATE_FIELD', key: deviceKey, field: 'gearValue', value: Math.round(rounded * 10) });
    };

    const handleToggleF1 = async () => {
        if (c.testType === 'Cycle' && isTesting) {
            dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'starting', testType: 'Cycle' });
            const ok = await onStopF1(connectionId, uid);
            if (ok) {
                dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'idle', testType: null });
                dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'success', message: 'F1测试已停止' });
            } else {
                dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'testing', testType: 'Cycle' });
                dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'error', message: '停止F1测试失败' });
            }
        } else {
            dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'starting', testType: 'Cycle' });
            dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'info', message: '启动F1测试中...' });
            const ok = await onStartF1(connectionId, uid, c.periodSeconds, c.gearValue);
            if (ok) {
                dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'testing', testType: 'Cycle' });
                dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'success', message: 'F1测试运行中' });
            } else {
                dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'idle', testType: null });
                dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'error', message: '启动F1测试失败' });
            }
        }
    };

    const handleStartSingle = async () => {
        dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'starting', testType: 'Single' });
        dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'info', message: '启动单次测试中...' });
        const ok = await onStartSingle(connectionId, uid, c.gearValue);
        if (ok) {
            dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'testing', testType: 'Single' });
            dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'success', message: '单次测试运行中' });
        } else {
            dispatch({ type: 'SET_TESTING_STATE', key: deviceKey, state: 'idle', testType: null });
            dispatch({ type: 'ADD_FEEDBACK', key: deviceKey, level: 'error', message: '启动单次测试失败' });
        }
    };

    return (
        <Box sx={{ border: '1px solid', borderColor: isOnline ? 'success.main' : 'grey.400', borderRadius: 2, p: 2, bgcolor: isOnline ? '#fff' : '#f9f9f9', opacity: isOnline ? 1 : 0.7, minHeight: 250, display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="subtitle1" fontWeight="bold">UID: {uid}</Typography>
                <Typography variant="caption" sx={{ color: isOnline ? 'success.main' : 'text.disabled', fontWeight: 'bold' }}>
                    {isOnline ? '● 在线' : '○ 离线'}
                </Typography>
            </Box>

            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
                <TextField
                    label="周期(秒)" size="small" variant="standard"
                    value={c.periodSecondsInput} onChange={handlePeriodChange} onBlur={handlePeriodBlur}
                    disabled={isTesting || !isOnline}
                    sx={{ width: '50%' }}
                />
                <TextField
                    label="档位(mA)" size="small" variant="standard"
                    value={c.gearInput} onChange={handleGearChange} onBlur={handleGearBlur}
                    disabled={isTesting || !isOnline}
                    sx={{ width: '50%' }}
                />
            </Box>

            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
                <Button
                    variant="contained" size="small"
                    color={c.testType === 'Cycle' && isTesting ? "error" : "primary"}
                    disabled={(!isOnline) || (isTesting && c.testType !== 'Cycle') || c.testingState === 'starting'}
                    onClick={handleToggleF1}
                    fullWidth
                >
                    {c.testType === 'Cycle' && isTesting ? "停止周期" : "周期测试"}
                </Button>
                <Button
                    variant="outlined" size="small" color="secondary"
                    disabled={!isOnline || isTesting}
                    onClick={handleStartSingle}
                    fullWidth
                >
                    单次测试
                </Button>
            </Box>

            <Box sx={{ mt: 'auto' }}>
                {c.lastfeedback && (
                    <Alert severity={c.lastfeedback.level} sx={{ p: 0, '& .MuiAlert-message': { p: 0.5, fontSize: '0.75rem' }, '& .MuiAlert-icon': { p: 0.5, display: 'none' } }}>
                        {c.lastfeedback.message}
                    </Alert>
                )}
                {statusData?.dataReady && (
                    <Typography variant="caption" color="success.main" display="block">DATA_READY: 1 (数据已就绪)</Typography>
                )}
                {hasHistory && (
                    <Button
                        size="small"
                        variant="outlined"
                        color="info"
                        onClick={() => { setOpenRawDialog(true); setHistoryIndex(historyCount - 1); }}
                        sx={{ mt: 1, fontSize: '0.75rem', py: 0.2, textTransform: 'none' }}
                        fullWidth
                    >
                        查看 RAW Rsei / Rct 数据 ({historyCount}次)
                    </Button>
                )}
            </Box>

            <Dialog
                open={openRawDialog}
                onClose={() => setOpenRawDialog(false)}
                maxWidth="md"
                fullWidth
            >
                <DialogTitle sx={{ pb: 1, fontWeight: 'bold', textTransform: 'none' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: hasHistory && historyCount > 1 ? 0.5 : 0 }}>
                        <span>UID {uid} RAW Rsei / Rct 采样数据</span>
                        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 'normal' }}>
                            采集时间: {selectedRaw ? new Date(selectedRaw.timestamp).toLocaleString() : ''}
                        </Typography>
                    </Box>
                    {hasHistory && historyCount > 1 && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                            <Button size="small" variant="outlined" onClick={() => setHistoryIndex(Math.max(0, historyIndex - 1))} disabled={historyIndex <= 0} sx={{ minWidth: 60, fontSize: '0.7rem', py: 0.2 }}>
                                上一个
                            </Button>
                            <Typography variant="caption" sx={{ minWidth: 70, textAlign: 'center' }}>
                                第 {historyIndex + 1}/{historyCount} 次
                            </Typography>
                            <Button size="small" variant="outlined" onClick={() => setHistoryIndex(Math.min(historyCount - 1, historyIndex + 1))} disabled={historyIndex >= historyCount - 1} sx={{ minWidth: 60, fontSize: '0.7rem', py: 0.2 }}>
                                下一个
                            </Button>
                        </Box>
                    )}
                </DialogTitle>
                <DialogContent dividers sx={{ p: 2, textTransform: 'none' }} >
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        解析公式：解析值 = 原始值 * 1000 / 480。共采集 32 个采样点。
                    </Typography>

                    {selectedRaw && (selectedRaw.r1 !== undefined || selectedRaw.r2 !== undefined || selectedRaw.r3 !== undefined) && (
                        <Box sx={{ mb: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                            {selectedRaw.voltage !== undefined && (
                                <Typography variant="body2">
                                    <b>OCV:</b> {selectedRaw.voltage} mV
                                </Typography>
                            )}
                            <Typography variant="body2">
                                <b>Rohm:</b> {selectedRaw.r1 !== undefined ? selectedRaw.r1.toFixed(0) + ' μΩ' : 'N/A'}
                            </Typography>
                            <Typography variant="body2">
                                <b>Rsei:</b> {selectedRaw.r2 !== undefined ? selectedRaw.r2.toFixed(0) + ' μΩ' : 'N/A'}
                            </Typography>
                            <Typography variant="body2">
                                <b>Rct:</b> {selectedRaw.r3 !== undefined ? selectedRaw.r3.toFixed(0) + ' μΩ' : 'N/A'}
                            </Typography>
                        </Box>
                    )}

                    <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2, textTransform: 'none' }}>
                        <Tabs value={tabValue} onChange={(_, newValue) => setTabValue(newValue)}>
                            <Tab sx={{ textTransform: 'none' }} label={`RAW Rsei 数据 (${selectedRaw?.rawR2?.length || 0}reg)`} />
                            <Tab sx={{ textTransform: 'none' }} label={`RAW Rct 数据 (${selectedRaw?.rawR3?.length || 0}reg)`} />
                        </Tabs>
                    </Box>

                    {tabValue === 0 && selectedRaw && (
                        <TableContainer component={Paper} sx={{ maxHeight: 350, overflowY: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead>
                                    <TableRow>
                                        <TableCell align="center"><b>采样点 (Index)</b></TableCell>
                                        <TableCell align="center"><b>原始值 (Raw)</b></TableCell>
                                        <TableCell align="center"><b>解析值 (Parsed)</b></TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {selectedRaw.rawR2.map((val, idx) => {
                                        const parsedVal = selectedRaw.parsedR2[idx];
                                        return (
                                            <TableRow key={idx} hover>
                                                <TableCell align="center">{idx + 1}</TableCell>
                                                <TableCell align="center">{val}</TableCell>
                                                <TableCell align="center" sx={{ color: 'primary.main', fontWeight: 'bold' }}>
                                                    {parsedVal !== undefined ? parsedVal.toFixed(3) : '-'}
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                    {selectedRaw.rawR2.length === 0 && (
                                        <TableRow>
                                            <TableCell colSpan={3} align="center" sx={{ py: 3, color: 'text.secondary' }}>暂无 R2 采样点数据</TableCell>
                                        </TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}

                    {tabValue === 1 && selectedRaw && (
                        <TableContainer component={Paper} sx={{ maxHeight: 350, overflowY: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead>
                                    <TableRow>
                                        <TableCell align="center"><b>采样点 (Index)</b></TableCell>
                                        <TableCell align="center"><b>原始值 (Raw)</b></TableCell>
                                        <TableCell align="center"><b>解析值 (Parsed)</b></TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {selectedRaw.rawR3.map((val, idx) => {
                                        const parsedVal = selectedRaw.parsedR3[idx];
                                        return (
                                            <TableRow key={idx} hover>
                                                <TableCell align="center">{idx + 1}</TableCell>
                                                <TableCell align="center">{val}</TableCell>
                                                <TableCell align="center" sx={{ color: 'secondary.main', fontWeight: 'bold' }}>
                                                    {parsedVal !== undefined ? parsedVal.toFixed(3) : '-'}
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                    {selectedRaw.rawR3.length === 0 && (
                                        <TableRow>
                                            <TableCell colSpan={3} align="center" sx={{ py: 3, color: 'text.secondary' }}>暂无 R3 采样点数据</TableCell>
                                        </TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpenRawDialog(false)} color="primary" variant="contained">
                        关闭
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default memo(DeviceCard);
