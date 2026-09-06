// ===========================================================================
//  CTRADERADAPTER001 — KERNEL DEL ADAPTADOR (capa sin SDK)
//  ---------------------------------------------------------------------------
//  Traduce entre la plataforma y los dos artefactos sellados:
//     Fluens.LocalDemo.Core      (guardián: 13 estados / 52 transiciones)
//     Fluens.LocalDemo.Strategy  (señal H1)
//  Ninguno de los dos se modifica: se leen en su ubicación original y se
//  compilan por ruta. Este archivo no referencia cAlgo.API.
//
//  Estado: BORRADOR NO APROBADO. Ningún veredicto autoriza este artefacto.
//  Primer modo de ejecución exigido por la autoridad humana: DRY_RUN_ZERO_ORDER.
// ===========================================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Fluens.LocalDemo.Adapter.Ports;
using Fluens.LocalDemo.Core;
using Fluens.LocalDemo.Strategy;

namespace Fluens.LocalDemo.Adapter
{
    // =======================================================================
    //  DECISIONES PENDIENTES, HECHAS EXPLÍCITAS
    //  Cada una corresponde a un UnresolvedRuntimeItem del core o a un
    //  StrategyRuntimeBoundaryItem. Mientras `Ratificados` sea falso, el
    //  evaluador de guardas NIEGA las guardas que dependen de ellos.
    //  Un umbral inventado es peor que ningún umbral: este diseño prefiere
    //  no operar antes que operar con un número que nadie aprobó.
    // =======================================================================
    public sealed class UmbralesRuntime
    {
        private UmbralesRuntime(bool ratificados, long quoteMaxAgeMillis, long heartbeatMaxAgeMillis,
                                long marketCloseBufferSeconds, long permitTtlTicks, int presupuestoEfectos)
        {
            Ratificados = ratificados;
            QuoteMaxAgeMillis = quoteMaxAgeMillis;
            HeartbeatMaxAgeMillis = heartbeatMaxAgeMillis;
            MarketCloseBufferSeconds = marketCloseBufferSeconds;
            PermitTtlTicks = permitTtlTicks;
            PresupuestoEfectosSesion = presupuestoEfectos;
        }

        public bool Ratificados { get; private set; }
        public long QuoteMaxAgeMillis { get; private set; }
        public long HeartbeatMaxAgeMillis { get; private set; }
        public long MarketCloseBufferSeconds { get; private set; }
        public long PermitTtlTicks { get; private set; }

        /// <summary>MEJORA: tope duro de efectos de bróker por sesión, independiente
        /// de la máquina de estados. Red de seguridad de último recurso.</summary>
        public int PresupuestoEfectosSesion { get; private set; }

        /// <summary>Estado real hoy: NADA ratificado. Bloquea toda entrada.</summary>
        public static UmbralesRuntime SinRatificar()
        {
            return new UmbralesRuntime(false, 0L, 0L, 0L, 0L, 0);
        }

        /// <summary>
        /// Solo para pruebas o para cuando el titular ratifique los valores.
        /// `presupuestoEfectos = 0` es una configuración VÁLIDA y significativa:
        /// es el modo DRY_RUN_ZERO_ORDER que exige la autoridad humana como primer
        /// modo de ejecución. Todo lo demás funciona y observa; ninguna orden sale.
        /// </summary>
        public static UmbralesRuntime Ratificar(long quoteMaxAgeMillis, long heartbeatMaxAgeMillis,
                                                long marketCloseBufferSeconds, long permitTtlTicks,
                                                int presupuestoEfectos)
        {
            if (quoteMaxAgeMillis <= 0L || heartbeatMaxAgeMillis <= 0L || marketCloseBufferSeconds < 0L
                || permitTtlTicks <= 0L || presupuestoEfectos < 0)
            {
                return SinRatificar();
            }
            return new UmbralesRuntime(true, quoteMaxAgeMillis, heartbeatMaxAgeMillis,
                                       marketCloseBufferSeconds, permitTtlTicks, presupuestoEfectos);
        }
    }

    // =======================================================================
    //  NORMALIZACIÓN DE SÍMBOLO
    //  AttributionKey.IsToken del core solo admite [A-Z0-9_-] y hasta 64.
    //  El instrumento inicial declarado por la autoridad humana es "CFG.US":
    //  contiene un punto, luego sin normalizar la posición sería INATRIBUIBLE
    //  y la reconciliación caería en QUIESCED sin cerrarla.
    //  Regla propuesta (PENDIENTE de ratificación): mayúsculas y sustitución
    //  de todo carácter no admitido por '_'. Determinista y reversible a la vista.
    // =======================================================================
    public static class SimboloPolitica
    {
        public static string Normalizar(string bruto)
        {
            if (string.IsNullOrEmpty(bruto) || bruto.Length > 64) { return null; }
            StringBuilder sb = new StringBuilder(bruto.Length);
            for (int i = 0; i < bruto.Length; i++)
            {
                char c = bruto[i];
                if (c >= 'a' && c <= 'z') { sb.Append((char)(c - 32)); continue; }
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') { sb.Append(c); continue; }
                sb.Append('_');
            }
            string salida = sb.ToString();
            return salida.Length == 0 ? null : salida;
        }
    }

    // =======================================================================
    //  CONVERSIONES DETERMINISTAS
    //  La estrategia hashea los cierres con ToString("G29"). Si la conversión
    //  double->decimal no es determinista, SeriesDigest e IntentDigest dejan de
    //  ser reproducibles frente a la evidencia offline.
    // =======================================================================
    public static class Conversion
    {
        public static bool TryHoraUtc(long unixSeconds, out long hora)
        {
            hora = 0L;
            if (unixSeconds < 0L) { return false; }
            if (unixSeconds % 3600L != 0L) { return false; }   // debe caer en hora exacta
            hora = unixSeconds / 3600L;
            return true;
        }

        public static bool TryPrecio(double valor, int digitos, out decimal precio)
        {
            precio = 0m;
            if (digitos < 0 || digitos > 8) { return false; }
            if (double.IsNaN(valor) || double.IsInfinity(valor)) { return false; }
            try
            {
                double redondeado = Math.Round(valor, digitos, MidpointRounding.AwayFromZero);
                string texto = redondeado.ToString("F" + digitos.ToString(CultureInfo.InvariantCulture),
                                                   CultureInfo.InvariantCulture);
                precio = decimal.Parse(texto, NumberStyles.Number, CultureInfo.InvariantCulture);
                return true;
            }
            catch (OverflowException) { return false; }
            catch (FormatException) { return false; }
        }
    }

    public enum PoliticaHueco
    {
        /// <summary>Conservador: si el prefijo no es contiguo, no se entrega nada.</summary>
        EsperarContiguidad,
        /// <summary>Toma el tramo contiguo más reciente tras el hueco.</summary>
        ReencuadrarTrasHueco
    }

    public sealed class VentanaH1
    {
        public VentanaH1(H1BarObservation[] barras, string motivo, int descartadasPorHueco)
        {
            Barras = barras;
            Motivo = motivo;
            DescartadasPorHueco = descartadasPorHueco;
        }

        public H1BarObservation[] Barras { get; private set; }
        public string Motivo { get; private set; }
        public int DescartadasPorHueco { get; private set; }
    }

    /// <summary>Construye el prefijo cerrado y contiguo que exige la estrategia.</summary>
    public static class ConstructorVentanaH1
    {
        public const int MinimoBarras = 5;

        public static VentanaH1 Construir(PlatformBar[] crudas, int digitos, PoliticaHueco politica, int ventana)
        {
            if (crudas == null || ventana < MinimoBarras)
            {
                return new VentanaH1(new H1BarObservation[0], "ENTRADA_INVALIDA", 0);
            }

            List<long> horas = new List<long>();
            List<decimal> cierres = new List<decimal>();
            for (int i = 0; i < crudas.Length; i++)
            {
                PlatformBar b = crudas[i];
                if (b == null || !b.ClosedByPlatform) { continue; }   // la barra en curso nunca entra
                long hora;
                decimal precio;
                if (!Conversion.TryHoraUtc(b.OpenTimeUnixSeconds, out hora)) { continue; }
                if (!Conversion.TryPrecio(b.Close, digitos, out precio)) { continue; }
                horas.Add(hora);
                cierres.Add(precio);
            }
            if (horas.Count == 0) { return new VentanaH1(new H1BarObservation[0], "SIN_BARRAS_CERRADAS", 0); }

            int inicio = 0;
            int descartadas = 0;
            bool contiguo = true;
            for (int i = 1; i < horas.Count; i++)
            {
                if (horas[i] != horas[i - 1] + 1L) { contiguo = false; inicio = i; }
            }
            if (!contiguo)
            {
                if (politica == PoliticaHueco.EsperarContiguidad)
                {
                    return new VentanaH1(new H1BarObservation[0], "HUECO_DE_CONTIGUIDAD", horas.Count);
                }
                descartadas = inicio;
            }

            int disponibles = horas.Count - inicio;
            if (disponibles < MinimoBarras)
            {
                return new VentanaH1(new H1BarObservation[0], "HISTORIA_INSUFICIENTE", descartadas);
            }

            int tomar = disponibles < ventana ? disponibles : ventana;
            int desde = horas.Count - tomar;
            H1BarObservation[] salida = new H1BarObservation[tomar];
            for (int i = 0; i < tomar; i++)
            {
                salida[i] = new H1BarObservation(horas[desde + i], cierres[desde + i],
                                                 true, true, true,
                                                 H1Timeframe.TF_1H, TimestampStandard.UTC);
            }
            return new VentanaH1(salida, "OK", descartadas);
        }
    }

    // =======================================================================
    //  EVALUADOR DE GUARDAS
    //  Traduce una foto de plataforma a hechos del core.
    //  Lo desconocido NUNCA se concede. Lo no ratificado tampoco.
    // =======================================================================
    public static class EvaluadorGuardas
    {
        public static GuardId[] Evaluar(PlatformSnapshot s, UmbralesRuntime u, bool exposicionAtribuibleConStop)
        {
            List<GuardId> g = new List<GuardId>();
            if (s == null || u == null) { return new GuardId[0]; }

            // --- Entorno ---
            HostEnvironmentKind kind = HostEnvironmentNormalizer.Normalize(
                MapearEntorno(s.EnvironmentKindRaw), s.EnvironmentReadable);
            if (HostEnvironmentNormalizer.EntryAllowed(kind, s.LocalVisibleSession) && s.RealTimeMode)
            {
                g.Add(GuardId.DESKTOP_VISIBLE);
            }

            // --- Cuenta ---
            if (s.AccountReadable && !s.AccountIsLive)
            {
                g.Add(GuardId.ACCOUNT_ISLIVE_FALSE);
                if (s.ConnectionArmEnvironmentEpochUnchanged) { g.Add(GuardId.ACCOUNT_ISLIVE_FALSE_CURRENT_EPOCH); }
            }
            if (s.AccountReadable && s.AccountNumberMatchesAllowlist)
            {
                g.Add(GuardId.PRIVATE_ACCOUNT_ALLOWLIST_MATCH);
                if (s.ConnectionArmEnvironmentEpochUnchanged) { g.Add(GuardId.PRIVATE_ACCOUNT_ALLOWLIST_MATCH_CURRENT_EPOCH); }
            }
            if (s.AccountReadable && !s.AccountSwitchedSinceArm) { g.Add(GuardId.ACCOUNT_NOT_SWITCHED); }

            // --- Epoch ---
            if (s.ConnectionArmEnvironmentEpochUnchanged)
            {
                g.Add(GuardId.CONNECTION_ARM_HEARTBEAT_ENVIRONMENT_EPOCH_UNCHANGED);
            }
            else
            {
                g.Add(GuardId.CONNECTION_ARM_HEARTBEAT_ENVIRONMENT_EPOCH_INVALIDATED);
            }
            if (s.CurrentSessionArmFresh) { g.Add(GuardId.CURRENT_SESSION_ARM_FRESH); }

            // --- Presencia humana (umbral no ratificado => no se concede) ---
            if (u.Ratificados && s.HumanArmed) { g.Add(GuardId.LOCAL_HUMAN_ARM); }
            if (u.Ratificados && s.HumanHeartbeatAgeMillis >= 0L
                && s.HumanHeartbeatAgeMillis <= u.HeartbeatMaxAgeMillis)
            {
                g.Add(GuardId.HUMAN_PRESENCE_HEARTBEAT_FRESH);
            }

            // --- Mercado ---
            if (s.SymbolReadable && s.TradingEnabled && s.TradingModeFullAccess)
            {
                g.Add(GuardId.MARKET_TRADING_ENABLED);
            }
            if (u.Ratificados && s.SymbolReadable && s.MarketOpen
                && s.SecondsTillMarketClose > u.MarketCloseBufferSeconds)
            {
                g.Add(GuardId.MARKET_HOURS_OPEN);
            }
            if (u.Ratificados && s.QuoteEverReceived && s.QuoteAgeMillis >= 0L
                && s.QuoteAgeMillis <= u.QuoteMaxAgeMillis)
            {
                g.Add(GuardId.LOCAL_QUOTE_AGE_FRESH);
            }

            // --- Contratos de símbolo ---
            if (s.SymbolReadable && s.VolumeContractComplete) { g.Add(GuardId.VOLUME_CONTRACT_COMPLETE); }
            if (s.SymbolReadable && s.CommissionContractComplete) { g.Add(GuardId.COMMISSION_CONTRACT_COMPLETE); }

            // --- Exposición ---
            int atribuibles = s.AttributablePositions == null ? 0 : s.AttributablePositions.Length;
            int inatribuibles = s.UnattributablePositions == null ? 0 : s.UnattributablePositions.Length;
            if (atribuibles == 0)
            {
                g.Add(GuardId.NO_FLUENS_EXPOSURE);
                g.Add(GuardId.NO_EXISTING_FLUENS_EXPOSURE);
            }
            if (s.PendingOrderCount == 0) { g.Add(GuardId.NO_UNEXPECTED_PENDING_ORDERS); }
            if (atribuibles == 0 && inatribuibles == 0 && s.PendingOrderCount == 0)
            {
                g.Add(GuardId.RECONCILIATION_CLEAN);
            }
            if (atribuibles > 0)
            {
                g.Add(GuardId.ATTRIBUTABLE_FLUENS_POSITION);
                g.Add(GuardId.POSITION_STILL_EXISTS);
                if (exposicionAtribuibleConStop)
                {
                    g.Add(GuardId.SERVER_SIDE_STOP_VERIFIED);
                    g.Add(GuardId.POSITION_STOPLOSS_NON_NULL);
                    g.Add(GuardId.VERIFIED_PROTECTED_POSITION_PRESENT);
                }
                else
                {
                    g.Add(GuardId.SERVER_SIDE_STOP_NOT_VERIFIED);
                    g.Add(GuardId.POSITION_STOPLOSS_NULL);
                }
            }

            // --- Journal y autoridad ---
            if (s.AuthorityHashMatches) { g.Add(GuardId.AUTHORITY_HASH_MATCH); }
            if (s.JournalReady) { g.Add(GuardId.JOURNAL_READY); }
            if (s.SessionEntryAvailable) { g.Add(GuardId.SESSION_ENTRY_AVAILABLE); }

            return g.ToArray();
        }

        private static HostEnvironmentKind MapearEntorno(int bruto)
        {
            if (bruto == 0) { return HostEnvironmentKind.DESKTOP; }
            if (bruto == 1) { return HostEnvironmentKind.NON_DESKTOP; }
            return HostEnvironmentKind.UNKNOWN;
        }
    }

    // =======================================================================
    //  RECONCILIADOR
    // =======================================================================
    public static class Reconciliador
    {
        public static ReconcileObservation Clasificar(PlatformSnapshot s, bool epochInvalidado)
        {
            if (s == null || !s.AccountReadable || s.AccountIsLive) { return ReconcileObservation.LIVE_OR_UNKNOWN; }

            int inatribuibles = s.UnattributablePositions == null ? 0 : s.UnattributablePositions.Length;
            if (inatribuibles > 0 || s.PendingOrderCount > 0)
            {
                return ReconcileObservation.MANUAL_UNATTRIBUTABLE_CONTRADICTORY_PENDING;
            }

            PlatformPosition[] mias = s.AttributablePositions == null ? new PlatformPosition[0] : s.AttributablePositions;
            if (mias.Length > 0)
            {
                bool todasProtegidas = true;
                for (int i = 0; i < mias.Length; i++)
                {
                    if (mias[i] == null || !mias[i].HasStopLoss) { todasProtegidas = false; }
                }
                return todasProtegidas ? ReconcileObservation.ATTRIBUTABLE_PROTECTED
                                       : ReconcileObservation.ATTRIBUTABLE_UNPROTECTED;
            }

            return epochInvalidado ? ReconcileObservation.RECONNECT_CLEAN_REARM_REQUIRED
                                   : ReconcileObservation.CURRENT_SESSION_CLEAN_FRESH_ARM;
        }
    }

    // =======================================================================
    //  CANONICALIZACIÓN DEL PERMISO
    //  El core enumera los 16 PermitFieldId pero no fija su serialización.
    //  Aquí se fija: orden del enum, separador '|', cultura invariante,
    //  volumen con 8 decimales, stop con 8 decimales. PENDIENTE de ratificación.
    // =======================================================================
    public sealed class DatosPermiso
    {
        public DatosPermiso()
        {
            AuthoritySha256 = string.Empty; HumanPresenceSessionSha256 = string.Empty;
            PlatformContractSha256 = string.Empty; RiskResultSha256 = string.Empty;
            AccountSessionSha256 = string.Empty; SymbolSnapshotSha256 = string.Empty;
            QuoteSnapshotSha256 = string.Empty; IntentSha256 = string.Empty;
            JournalTipSha256 = string.Empty; Environment = string.Empty;
            Symbol = string.Empty; Side = string.Empty; Nonce = string.Empty;
        }

        public string AuthoritySha256 { get; set; }
        public string HumanPresenceSessionSha256 { get; set; }
        public string PlatformContractSha256 { get; set; }
        public string RiskResultSha256 { get; set; }
        public string AccountSessionSha256 { get; set; }
        public string SymbolSnapshotSha256 { get; set; }
        public string QuoteSnapshotSha256 { get; set; }
        public string IntentSha256 { get; set; }
        public string JournalTipSha256 { get; set; }
        public string Environment { get; set; }
        public string Symbol { get; set; }
        public string Side { get; set; }
        public double VolumeInUnits { get; set; }
        public double ServerSideStop { get; set; }
        public long Expiry { get; set; }
        public string Nonce { get; set; }
    }

    public static class CanonicalizadorPermiso
    {
        public static string Canonicalizar(DatosPermiso d)
        {
            if (d == null) { return null; }
            StringBuilder sb = new StringBuilder();
            PermitFieldId[] campos = CanonicalModel.GetPermitFields();
            for (int i = 0; i < campos.Length; i++)
            {
                if (i != 0) { sb.Append('|'); }
                sb.Append(campos[i].ToString()).Append('=').Append(Valor(d, campos[i]));
            }
            return sb.ToString();
        }

        public static string HuellaVinculo(DatosPermiso d)
        {
            string canonico = Canonicalizar(d);
            return canonico == null ? null : CanonicalModel.Sha256(canonico);
        }

        private static string Valor(DatosPermiso d, PermitFieldId campo)
        {
            switch (campo)
            {
                case PermitFieldId.AUTHORITY_SHA256: return d.AuthoritySha256;
                case PermitFieldId.HUMAN_PRESENCE_SESSION_SHA256: return d.HumanPresenceSessionSha256;
                case PermitFieldId.PLATFORM_CONTRACT_SHA256: return d.PlatformContractSha256;
                case PermitFieldId.RISK_RESULT_SHA256: return d.RiskResultSha256;
                case PermitFieldId.ACCOUNT_SESSION_SHA256: return d.AccountSessionSha256;
                case PermitFieldId.SYMBOL_SNAPSHOT_SHA256: return d.SymbolSnapshotSha256;
                case PermitFieldId.QUOTE_SNAPSHOT_SHA256: return d.QuoteSnapshotSha256;
                case PermitFieldId.INTENT_SHA256: return d.IntentSha256;
                case PermitFieldId.JOURNAL_TIP_SHA256: return d.JournalTipSha256;
                case PermitFieldId.ENVIRONMENT: return d.Environment;
                case PermitFieldId.SYMBOL: return d.Symbol;
                case PermitFieldId.SIDE: return d.Side;
                case PermitFieldId.VOLUME_IN_UNITS: return d.VolumeInUnits.ToString("F8", CultureInfo.InvariantCulture);
                case PermitFieldId.SERVER_SIDE_STOP: return d.ServerSideStop.ToString("F8", CultureInfo.InvariantCulture);
                case PermitFieldId.EXPIRY: return d.Expiry.ToString(CultureInfo.InvariantCulture);
                case PermitFieldId.NONCE: return d.Nonce;
                default: return string.Empty;
            }
        }
    }

    // =======================================================================
    //  COMPUERTA SERIAL DE EFECTOS  (+ MEJORA: presupuesto por sesión)
    //  Un solo efecto de bróker en vuelo. Nunca dos. Y un tope duro de efectos
    //  por sesión que ninguna ruta de la máquina de estados puede sobrepasar.
    // =======================================================================
    public sealed class CompuertaEfectos
    {
        private readonly int _presupuesto;
        private int _enVuelo;
        private int _usados;
        private int _maximoConcurrente;

        public CompuertaEfectos(int presupuesto)
        {
            _presupuesto = presupuesto < 0 ? 0 : presupuesto;
            _enVuelo = 0;
            _usados = 0;
            _maximoConcurrente = 0;
        }

        public int Usados { get { return _usados; } }
        public int Presupuesto { get { return _presupuesto; } }
        public bool EnVuelo { get { return _enVuelo > 0; } }
        public bool PresupuestoAgotado { get { return _usados >= _presupuesto; } }

        /// <summary>Pico de efectos simultáneos observado. La invariante del sistema
        /// es que NUNCA pase de 1; el simulador adversario lo verifica.</summary>
        public int MaximoConcurrente { get { return _maximoConcurrente; } }

        public bool TryIniciar(out string motivo)
        {
            if (_enVuelo > 0) { motivo = "EFECTO_YA_EN_VUELO"; return false; }
            if (PresupuestoAgotado) { motivo = "PRESUPUESTO_DE_EFECTOS_AGOTADO"; return false; }
            _enVuelo++;
            if (_enVuelo > _maximoConcurrente) { _maximoConcurrente = _enVuelo; }
            _usados++;
            motivo = "OK";
            return true;
        }

        public void Terminar()
        {
            if (_enVuelo > 0) { _enVuelo--; }
        }
    }

    // =======================================================================
    //  ESTADO DE SESIÓN
    //  El core no guarda estado: lo guarda el adaptador.
    // =======================================================================
    public sealed class EstadoSesion
    {
        public EstadoSesion()
        {
            Actual = RuntimeState.OFFLINE_PREPARED;
            HuellaVinculoActual = string.Empty;
            HuellaPermiso = string.Empty;
            Etiqueta = string.Empty;
            SimboloToken = string.Empty;
        }

        public RuntimeState Actual { get; set; }
        public PurePermit Permiso { get; set; }
        public string HuellaVinculoActual { get; set; }
        public string HuellaPermiso { get; set; }
        public string Etiqueta { get; set; }
        public string SimboloToken { get; set; }
        public bool EpochInvalidado { get; set; }
        public bool NuevasEntradasDesarmadas { get; set; }
        public bool RuntimeDetenido { get; set; }
    }

    /// <summary>Contadores para verificar invariantes globales desde las pruebas.</summary>
    public sealed class Contadores
    {
        public int EntradasEnviadas { get; set; }
        public int CierresEnviados { get; set; }
        public int EntradasRechazadasPorIdempotencia { get; set; }
        public int EntradasRechazadasPorPresupuesto { get; set; }
        public int EntradasRechazadasPorRiesgo { get; set; }
        public int ReintentosBloqueados { get; set; }
        public int TransicionesFallidasCerradas { get; set; }
        public int VecesEnLiveLocked { get; set; }
    }

    // =======================================================================
    //  RUNTIME DEL ADAPTADOR
    // =======================================================================
    public sealed class AdapterRuntime
    {
        private readonly DomainEngine _motor;
        private readonly IMonotonicClock _reloj;
        private readonly IPlatformObserver _observador;
        private readonly IH1BarSource _barras;
        private readonly IOrderEffectPort _ordenes;
        private readonly IJournalPort _journal;
        private readonly IRiskEnvelopePort _riesgo;
        private readonly IRuntimeStop _parada;
        private readonly UmbralesRuntime _umbrales;
        private readonly CompuertaEfectos _compuerta;
        private readonly PoliticaHueco _politicaHueco;
        private readonly int _digitos;
        private readonly int _ventana;
        private readonly string _huellaPlanFuente;

        public AdapterRuntime(IMonotonicClock reloj, IPlatformObserver observador, IH1BarSource barras,
                              IOrderEffectPort ordenes, IJournalPort journal, IRiskEnvelopePort riesgo,
                              IRuntimeStop parada, UmbralesRuntime umbrales, PoliticaHueco politicaHueco,
                              int digitos, int ventana, string huellaPlanFuente, string etiqueta)
        {
            _motor = new DomainEngine();
            _reloj = reloj;
            _observador = observador;
            _barras = barras;
            _ordenes = ordenes;
            _journal = journal;
            _riesgo = riesgo;
            _parada = parada;
            _umbrales = umbrales;
            _politicaHueco = politicaHueco;
            _digitos = digitos;
            _ventana = ventana;
            _huellaPlanFuente = huellaPlanFuente == null ? string.Empty : huellaPlanFuente;
            Sesion = new EstadoSesion();
            Sesion.Etiqueta = etiqueta == null ? string.Empty : etiqueta;
            Cuenta = new Contadores();
            _compuerta = new CompuertaEfectos(umbrales == null ? 0 : umbrales.PresupuestoEfectosSesion);
            UltimoMotivo = string.Empty;
        }

        public EstadoSesion Sesion { get; private set; }
        public Contadores Cuenta { get; private set; }
        public CompuertaEfectos Compuerta { get { return _compuerta; } }
        public string UltimoMotivo { get; private set; }

        /// <summary>Arranque: siempre desarmado, nunca restaura un estado armado.</summary>
        public void Arrancar()
        {
            Sesion.Actual = RuntimeState.OFFLINE_PREPARED;
            Sesion.NuevasEntradasDesarmadas = true;
            Aplicar(TransitionEvent.LOCAL_START, new GuardId[0]);
        }

        /// <summary>Aplica un evento y ejecuta el plan que devuelva el core.</summary>
        public TransitionDecision Aplicar(TransitionEvent evento, GuardId[] guardas)
        {
            if (Sesion.RuntimeDetenido) { UltimoMotivo = "RUNTIME_DETENIDO"; return null; }

            GuardSet conjunto = GuardSet.Create(guardas == null ? new GuardId[0] : guardas);
            TransitionDecision d = _motor.Evaluate(Sesion.Actual, evento, conjunto);
            if (!d.Allowed) { Cuenta.TransicionesFallidasCerradas++; }

            Sesion.Actual = d.To;
            UltimoMotivo = d.Reason;
            if (d.To == RuntimeState.LIVE_LOCKED) { Cuenta.VecesEnLiveLocked++; }

            EjecutarPlan(d);
            RegistrarTransicion(d);
            return d;
        }

        /// <summary>Señales de seguridad: el arbitraje del core decide cuál gana.</summary>
        public TransitionDecision AplicarSenalesSeguridad(SafetySignal[] senales, GuardId[] guardas)
        {
            SafetySignal elegida = SafetyEventArbiter.Select(senales);
            TransitionEvent evento;
            switch (elegida)
            {
                case SafetySignal.LIVE_OR_UNKNOWN_ACCOUNT: evento = TransitionEvent.LIVE_OR_UNKNOWN_ACCOUNT_DETECTED; break;
                case SafetySignal.ACCOUNT_SWITCH: evento = TransitionEvent.LIVE_OR_UNKNOWN_ACCOUNT_DETECTED; break;
                case SafetySignal.RECONNECT: evento = TransitionEvent.RECONNECT_DETECTED; break;
                case SafetySignal.HEARTBEAT_LOST: evento = TransitionEvent.HUMAN_PRESENCE_HEARTBEAT_LOST; break;
                default: evento = TransitionEvent.CANDIDATE_READY; break;
            }
            return Aplicar(evento, guardas);
        }

        /// <summary>Reconciliación tipada contra la plataforma.</summary>
        public TransitionDecision Reconciliar()
        {
            PlatformSnapshot s = _observador.Read();
            ReconcileObservation obs = Reconciliador.Clasificar(s, Sesion.EpochInvalidado);
            bool conStop = obs == ReconcileObservation.ATTRIBUTABLE_PROTECTED;
            GuardId[] g = EvaluadorGuardas.Evaluar(s, _umbrales, conStop);
            GuardSet conjunto = GuardSet.Create(g);

            TransitionDecision d = _motor.Reconcile(obs, conjunto);
            if (!d.Allowed) { Cuenta.TransicionesFallidasCerradas++; }
            Sesion.Actual = d.To;
            UltimoMotivo = d.Reason;
            if (d.To == RuntimeState.LIVE_LOCKED) { Cuenta.VecesEnLiveLocked++; }
            EjecutarPlan(d);
            RegistrarTransicion(d);
            return d;
        }

        /// <summary>Evalúa la señal sobre el prefijo cerrado. No produce efectos.</summary>
        public StrategyDecision EvaluarSenal()
        {
            PlatformBar[] crudas = _barras.ReadClosedWindow(_ventana);
            VentanaH1 v = ConstructorVentanaH1.Construir(crudas, _digitos, _politicaHueco, _ventana);
            if (v.Barras.Length == 0)
            {
                UltimoMotivo = "VENTANA_" + v.Motivo;
                return null;
            }
            // NOTA PENDIENTE: `ForOfflineEvaluation` es la única fábrica que habilita
            // la señal, pero su nombre declara alcance offline y el propio artefacto
            // fija RuntimeAuthorityGranted=false. Usarla en vivo requiere ratificación.
            StrategyConfiguration cfg = StrategyConfiguration.ForOfflineEvaluation(_huellaPlanFuente);
            return TrendPullbackContinuationH1.EvaluateClosedHistory(cfg, v.Barras, null);
        }

        /// <summary>
        /// Camino completo de entrada: señal -> riesgo -> permiso -> revalidación -> envío.
        /// Devuelve true solo si se envió exactamente una orden.
        /// </summary>
        public bool IntentarEntrada(StrategyDecision decision, DatosPermiso datos)
        {
            // Un runtime detenido no produce NINGÚN efecto nuevo, ni de entrada ni de
            // cierre: lo que protege una posición viva es el stop del servidor, que
            // persiste sin la aplicación. (Fallo encontrado por el simulador adversario.)
            if (Sesion.RuntimeDetenido) { UltimoMotivo = "RUNTIME_DETENIDO"; return false; }
            if (decision == null || datos == null) { UltimoMotivo = "SIN_DECISION"; return false; }
            if (decision.Signal == StrategySignal.ABSTAIN_ZERO) { UltimoMotivo = "SENAL_CERO"; return false; }
            if (Sesion.NuevasEntradasDesarmadas) { UltimoMotivo = "ENTRADAS_DESARMADAS"; return false; }

            // MEJORA: idempotencia por huella de intención. Sobrevive a reinicios
            // porque la huella se consulta en el journal, no en memoria.
            if (_journal.HasActedOnIntent(decision.IntentDigest))
            {
                Cuenta.EntradasRechazadasPorIdempotencia++;
                UltimoMotivo = "INTENCION_YA_ACTUADA";
                return false;
            }

            RiskEnvelope sobre = _riesgo.Evaluate(decision.IntentDigest);
            if (sobre == null || !sobre.Allow || sobre.VolumeInUnits <= 0d || sobre.StopLossPips <= 0d)
            {
                Cuenta.EntradasRechazadasPorRiesgo++;
                UltimoMotivo = "RIESGO_DENIEGA";
                return false;
            }

            string vinculoRiesgo = OpaqueRiskBinding.Bind(decision.IntentDigest, sobre.EnvelopeDigest);
            if (vinculoRiesgo == null) { UltimoMotivo = "VINCULO_RIESGO_INVALIDO"; return false; }

            datos.IntentSha256 = decision.IntentDigest;
            datos.RiskResultSha256 = vinculoRiesgo;
            datos.VolumeInUnits = sobre.VolumeInUnits;
            datos.ServerSideStop = sobre.StopLossPips;
            datos.Side = decision.Signal == StrategySignal.LONG ? "BUY" : "SELL";
            datos.Symbol = Sesion.SimboloToken;

            string vinculo = CanonicalizadorPermiso.HuellaVinculo(datos);
            if (vinculo == null) { UltimoMotivo = "VINCULO_INVALIDO"; return false; }
            Sesion.HuellaVinculoActual = vinculo;

            string nonce = CanonicalModel.Sha256(vinculo + ":" + datos.Nonce);
            PermitDecision emision = PermitDecision.Issue(nonce, vinculo, _reloj.NowTicks,
                                                         _umbrales.PermitTtlTicks, _reloj.Epoch, true);
            if (!emision.Issued || emision.Permit == null) { UltimoMotivo = "PERMISO_NO_EMITIDO"; return false; }
            Sesion.Permiso = emision.Permit;
            Sesion.HuellaPermiso = vinculo;

            // Revalidación inmediata: a las guardas de plataforma hay que sumar las
            // dos que solo conoce el permiso. Sin ellas, PermitDecision.Consume
            // exige guardas que nadie aporta y la entrada nunca se autorizaría.
            PlatformSnapshot s = _observador.Read();
            List<GuardId> inmediatas = new List<GuardId>(EvaluadorGuardas.Evaluar(s, _umbrales, false));
            if (PermitExpiryClock.IsUnexpired(_reloj.NowTicks, Sesion.Permiso.IssuedTicks,
                                              Sesion.Permiso.TtlTicks, Sesion.Permiso.Epoch, _reloj.Epoch))
            {
                inmediatas.Add(GuardId.PERMIT_UNEXPIRED);
            }
            if (string.Equals(Sesion.HuellaPermiso, vinculo, StringComparison.Ordinal))
            {
                inmediatas.Add(GuardId.PERMIT_BINDINGS_MATCH_CURRENT_RUNTIME);
            }
            PermitDecision consumo = PermitDecision.Consume(Sesion.Permiso, _reloj.NowTicks, _reloj.Epoch,
                                                           vinculo, GuardSet.Create(inmediatas.ToArray()));
            if (!consumo.Allowed) { UltimoMotivo = "REVALIDACION_FALLA:" + consumo.Reason; return false; }

            string motivo;
            if (!_compuerta.TryIniciar(out motivo))
            {
                if (motivo == "PRESUPUESTO_DE_EFECTOS_AGOTADO") { Cuenta.EntradasRechazadasPorPresupuesto++; }
                UltimoMotivo = motivo;
                return false;
            }

            TradeOutcome r;
            try
            {
                _journal.RecordActedIntent(decision.IntentDigest);   // antes del envío: pesimista a propósito
                Cuenta.EntradasEnviadas++;
                r = _ordenes.SubmitProtectedEntry(s.SymbolRawName, datos.Side == "BUY",
                                                  sobre.VolumeInUnits, sobre.StopLossPips, Sesion.Etiqueta);
            }
            finally
            {
                _compuerta.Terminar();
            }

            ClasificarResultadoEnvio(r);
            return true;
        }

        private void ClasificarResultadoEnvio(TradeOutcome r)
        {
            GuardId[] g;
            TransitionEvent ev;

            if (r == null || !r.CallReturned)
            {
                ev = TransitionEvent.AMBIGUOUS_RESULT;
                g = new GuardId[0];
            }
            else if (r.IsSuccessful && r.PositionReturned && r.PositionHasStopLoss)
            {
                ev = TransitionEvent.VERIFIED_PROTECTED_FILL;
                g = new GuardId[] { GuardId.TRADE_RESULT_SUCCESS, GuardId.RETURNED_POSITION_PRESENT,
                                    GuardId.POSITION_STOPLOSS_NON_NULL };
            }
            else if (r.PositionReturned && !r.PositionHasStopLoss)
            {
                ev = TransitionEvent.UNPROTECTED_FILL_FOUND;
                g = new GuardId[] { GuardId.FILL_EXISTS, GuardId.POSITION_STOPLOSS_NULL };
            }
            else if (!r.IsSuccessful && !r.PositionReturned && EsFalloLimpio(r.ErrorCode))
            {
                ev = TransitionEvent.CLEAR_FAILURE_NO_FILL;
                g = new GuardId[0];
            }
            else
            {
                ev = TransitionEvent.AMBIGUOUS_RESULT;   // incluye IsSuccessful sin posición
                g = new GuardId[0];
            }

            Aplicar(ev, g);
        }

        private static bool EsFalloLimpio(string codigo)
        {
            // Timeout y Disconnected NO son fallos limpios: la orden pudo llegar.
            return codigo == "BadVolume" || codigo == "NoMoney" || codigo == "MarketClosed"
                || codigo == "InvalidStopLossTakeProfit" || codigo == "InvalidRequest"
                || codigo == "NoTradingPermission" || codigo == "UnknownSymbol";
        }

        /// <summary>Cierre protector. Nunca reintenta.</summary>
        public bool IntentarCierre(int positionId)
        {
            if (Sesion.RuntimeDetenido) { UltimoMotivo = "RUNTIME_DETENIDO"; return false; }
            string motivo;
            if (!_compuerta.TryIniciar(out motivo)) { UltimoMotivo = motivo; return false; }
            TradeOutcome r;
            try
            {
                Cuenta.CierresEnviados++;
                r = _ordenes.CloseAttributable(positionId);
            }
            finally { _compuerta.Terminar(); }

            if (r == null || !r.CallReturned) { Aplicar(TransitionEvent.AMBIGUOUS_CLOSE, new GuardId[0]); }
            else if (r.IsSuccessful) { Aplicar(TransitionEvent.FLAT_VERIFIED, new GuardId[0]); }
            else { Aplicar(TransitionEvent.AMBIGUOUS_CLOSE, new GuardId[0]); }
            return true;
        }

        private void EjecutarPlan(TransitionDecision d)
        {
            if (d == null) { return; }
            EffectId[] efectos = d.Effects;
            for (int i = 0; i < efectos.Length; i++)
            {
                switch (efectos[i])
                {
                    case EffectId.DISARM_NEW_ENTRIES:
                        Sesion.NuevasEntradasDesarmadas = true;
                        break;
                    case EffectId.INVALIDATE_CONNECTION_ARM_HEARTBEAT_ENVIRONMENT_EPOCH:
                        Sesion.EpochInvalidado = true;
                        break;
                    case EffectId.INVALIDATE_PERMIT:
                        Sesion.Permiso = null;
                        Sesion.HuellaPermiso = string.Empty;
                        break;
                    case EffectId.STOP_RUNTIME:
                        Sesion.RuntimeDetenido = true;
                        if (_parada != null) { _parada.StopRuntime(); }
                        break;
                    case EffectId.NO_ENTRY_RETRY:
                    case EffectId.NO_CLOSE_RETRY:
                        Cuenta.ReintentosBloqueados++;
                        break;
                    case EffectId.KEEP_CURRENT_SESSION_ARM_BINDING:
                        Sesion.NuevasEntradasDesarmadas = false;
                        break;
                    default:
                        break;   // el resto son marcas de política que no producen efecto externo
                }
            }
        }

        private void RegistrarTransicion(TransitionDecision d)
        {
            if (d == null || _journal == null || !_journal.Ready) { return; }
            string linea = d.From.ToString() + "|" + d.Event.ToString() + "|" + d.To.ToString()
                         + "|" + (d.Allowed ? "ALLOW" : "FAILCLOSED") + "|" + d.Reason;
            _journal.Append("fluens.adapter", linea);
        }
    }
}
